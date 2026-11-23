"""Explicit disk-only installation. Service reload is a separate operator action.

No runner, engine, image or registration mutations. A retained journal makes
interrupted installation recoverable without guessing ownership.
"""

import argparse
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("arena_runtime", Path(__file__).with_name("arena-ci-runtime.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
require = runtime.require
Refusal = runtime.Refusal


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def atomic(path, data, mode, group=None):
    fd, temporary = tempfile.mkstemp(prefix=".arena-ci-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            if group is not None:
                os.fchown(stream.fileno(), os.getuid(), group)
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def safe_directory(path):
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
                f"unsafe root-owned installation parent: {parent}")


class Operations:
    def command(self, args):
        try:
            result = subprocess.run(args, capture_output=True, timeout=60, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal(f"installer dependency unavailable: {Path(args[0]).name}") from exc
        require(result.returncode == 0, f"installer dependency failed: {Path(args[0]).name}")
        return result.stdout

    def idle(self, config):
        # Conservative across the whole account, including orphaned workers.
        output = self.command(["/bin/ps", "-axo", "uid=,pid=,ppid=,comm="]).decode()
        rows = [line.split(None, 3) for line in output.splitlines() if line.strip()]
        # macOS reports the nobody account as signed UID -2.
        require(rows and all(len(row) == 4 and re.fullmatch(r"-?[0-9]+", row[0])
                             and all(x.isdigit() for x in row[1:3]) for row in rows),
                "cannot establish worker process ownership")
        for uid, _pid, _ppid, command in rows:
            if "Runner.Worker" in command:
                require(int(uid) != config["uid"], "active Runner.Worker; wait for idle, never interrupt CI")

    def service(self, original, config):
        output = self.command(["/bin/launchctl", "print", "system/" + runtime.LABEL]).decode()
        program = original.get("Program", original["ProgramArguments"][0])
        require(re.search(r"^\s*program = " + re.escape(program) + r"\s*$", output, re.M)
                and (re.search(r"^\s*username = ci-runner\s*$", output, re.M)
                     or re.search(r"^\s*uid = " + str(config["uid"]) + r"\s*$", output, re.M)),
                "loaded daemon ownership/source uncertain; inspect launchctl before installing")

    def pin(self, nix_store, target, link):
        self.command([str(nix_store), "--add-root", str(link), "--indirect", "--realise", str(target)])


class Installation:
    def __init__(self, profile, config_path, root=runtime.ROOT, daemon=runtime.DAEMON,
                 ops=None, validate_parents=safe_directory):
        self.profile = profile.resolve(strict=True)
        self.config_path = config_path
        self.root = root
        self.daemon = daemon
        self.ops = ops or Operations()
        self.validate_parents = validate_parents
        self.assets = self.profile / "share/arena-ci"
        runtime.protected(config_path, private=True)
        self.config = runtime.load_config(config_path)

    def original(self):
        runtime.protected(self.daemon)
        data = self.daemon.read_bytes()
        require(digest(data) == self.config["expected_daemon_sha256"],
                "daemon differs from explicitly captured original; unknown ownership")
        value = plistlib.loads(data)
        config = self.config
        require(value.get("Label") == runtime.LABEL
                and value.get("UserName") == config["user"]
                and value.get("GroupName") == "staff"
                and value.get("ProgramArguments") == [config["runner"]]
                and value.get("Program", config["runner"]) == config["runner"]
                and value.get("RunAtLoad") is True and value.get("KeepAlive") is True,
                "unexpected existing daemon identity/command/lifecycle")
        env = value.get("EnvironmentVariables", {})
        expected = {"HOME": config["home"], "USER": config["user"], "LOGNAME": config["user"],
                    "RUNNER_ROOT": config["runner_root"], "ARENA_RUNNER_LEASE_PATH": config["lease_path"]}
        require(all(env.get(k) == v for k, v in expected.items())
                and env.get("PATH") and env.get("NX_CACHE_DIRECTORY")
                and "ACTIONS_RUNNER_HOOK_JOB_STARTED" not in env,
                "unexpected original runner environment or existing job hook")
        require(Path(config["runner"]).resolve(strict=True).is_relative_to(Path(config["runner_store"])),
                "original runner closure identity changed")
        require(Path(config["work_folder"]).is_absolute()
                and not Path(config["work_folder"]).is_relative_to(Path(config["runner_root"])),
                "work folder must remain outside the registration checkout")
        # Read only the public registration metadata, never .credentials or .env.
        registration = json.loads((Path(config["runner_root"]) / ".runner").read_bytes())
        require(registration.get("workFolder") == config["work_folder"],
                "existing registration workFolder differs; never rewrite registration")
        self.ops.idle(config)
        self.ops.service(value, config)
        return data, value

    def plan(self):
        self.validate_parents(self.daemon.parent)
        self.validate_parents(self.root.parent)
        require(not self.root.exists() and not self.root.is_symlink(),
                "feature state already exists; retain it, inspect receipt and rollback before any operator-led upgrade")
        data, original = self.original()
        updated = dict(original)
        updated.pop("Program", None)
        updated["ProgramArguments"] = ["/bin/sh", str(self.root / "bootstrap.sh")]
        updated["WorkingDirectory"] = str(self.root)
        updated["StandardOutPath"] = str(self.root / "logs/stdout.log")
        updated["StandardErrorPath"] = str(self.root / "logs/stderr.log")
        updated["ThrottleInterval"] = 30
        updated["EnvironmentVariables"] = dict(original["EnvironmentVariables"])
        updated["EnvironmentVariables"]["ACTIONS_RUNNER_HOOK_JOB_STARTED"] = str(self.root / "job-start.sh")
        files = {
            "config.json": (encode(self.config), 0o644),
            "bootstrap.sh": ((self.assets / "bootstrap.sh").read_bytes(), 0o755),
            "job-start.sh": ((self.assets / "job-start.sh").read_bytes(), 0o755),
        }
        return data, plistlib.dumps(updated), files

    def apply(self):
        original, updated, files = self.plan()
        daemon_info = self.daemon.lstat()
        self.root.mkdir(mode=0o755)
        self.root.chmod(0o755)
        # All state remains after rollback for recovery/audit and GC safety.
        (self.root / "backups").mkdir(mode=0o700)
        (self.root / "logs").mkdir(mode=0o755)
        (self.root / "backups").chmod(0o700)
        (self.root / "logs").chmod(0o755)
        for name in ("stdout.log", "stderr.log"):
            atomic(self.root / "logs" / name, b"", 0o600)
            os.chown(self.root / "logs" / name, self.config["uid"], -1)
        atomic(self.root / "backups/original.plist", original, 0o600)
        atomic(self.root / "backups/installed.plist", updated, 0o600)
        receipt = {"schema": "arena-ci.install.v1", "profile": str(self.profile),
                   "daemon_mode": stat.S_IMODE(daemon_info.st_mode), "daemon_gid": daemon_info.st_gid,
                   "original": digest(original), "installed": digest(updated),
                   "files": {k: digest(v[0]) for k, v in files.items()}, "phase": "prepared"}
        atomic(self.root / "receipt.json", encode(receipt), 0o600)
        nix_store = self.assets / "nix-store"
        self.ops.pin(nix_store, self.profile, self.root / "package-closure")
        self.ops.pin(nix_store, self.config["runner_store"], self.root / "runner-closure")
        for name, (data, mode) in files.items():
            atomic(self.root / name, data, mode)
        # Recheck after pin/staging; no signal or launchctl mutation ever occurs.
        self.original()
        atomic(self.daemon, updated, receipt["daemon_mode"], receipt["daemon_gid"])
        receipt["phase"] = "installed"
        atomic(self.root / "receipt.json", encode(receipt), 0o600)
        return receipt

    def rollback(self):
        self.validate_parents(self.root)
        self.validate_parents(self.daemon.parent)
        receipt_path = self.root / "receipt.json"
        runtime.protected(receipt_path, private=True)
        receipt = json.loads(receipt_path.read_bytes())
        require(receipt.get("schema") == "arena-ci.install.v1"
                and receipt.get("phase") in ("prepared", "installed", "rolled-back"),
                "unknown recovery receipt")
        self.ops.idle(self.config)
        original_path = self.root / "backups/original.plist"
        installed_path = self.root / "backups/installed.plist"
        runtime.protected(original_path, private=True)
        runtime.protected(installed_path, private=True)
        original = original_path.read_bytes()
        installed = installed_path.read_bytes()
        require(digest(original) == receipt["original"] == self.config["expected_daemon_sha256"]
                and digest(installed) == receipt["installed"], "backup identity changed")
        runtime.protected(self.daemon)
        require(digest(self.daemon.read_bytes()) in (receipt["installed"], receipt["original"]),
                "daemon changed after install; preserve it and inspect manually")
        for name, expected in receipt["files"].items():
            require(name in ("config.json", "bootstrap.sh", "job-start.sh"), "unknown managed file")
            path = self.root / name
            if path.exists() or path.is_symlink():
                runtime.protected(path)
                require(digest(path.read_bytes()) == expected, "managed file changed; refuse rollback")
        atomic(self.daemon, original, receipt["daemon_mode"], receipt["daemon_gid"])
        receipt["phase"] = "rolled-back"
        atomic(receipt_path, encode(receipt), 0o600)
        return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("action", nargs="?", choices=("plan", "apply", "rollback"), default="plan")
    args = parser.parse_args()
    try:
        require(os.getuid() == 0, "run installer with sudo; plan is read-only")
        # Root-owned parent, fixed lock, never a worker-controlled lock path.
        if args.action == "plan":
            installation = Installation(args.profile, args.config)
            installation.plan()
            print("Plan: retain original plist; pin package + existing runner closures; install /Library/ArenaCI/{bootstrap.sh,job-start.sh,config.json}; replace only existing runner plist. No service reload, engine start or registration change.")
            return 0
        safe_directory(runtime.ROOT.parent)
        lock_path = runtime.ROOT.parent / ".arena-ci-install.lock"
        fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "r+") as lock:
            runtime.protected(lock_path, private=True)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            installation = Installation(args.profile, args.config)
            receipt = getattr(installation, args.action)()
            print("arena-ci: " + receipt["phase"] + "; pending activation. Backups/GC pins retained in /Library/ArenaCI. Service NOT reloaded. After confirming idle, operator must bootout/bootstrap the existing system daemon. Rollback also requires explicit service reload: same installer --config PRIVATE_CONFIG rollback.")
        return 0
    except (Refusal, OSError, ValueError, KeyError, TypeError) as exc:
        message = str(exc) if isinstance(exc, Refusal) else type(exc).__name__
        print("arena-ci: install refused: " + message + "; preserve /Library/ArenaCI receipt/backups", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
