"""Bounded, fail-closed admission for the existing Arena CI runner, not a supervisor."""

import argparse
import json
import os
from pathlib import Path
import plistlib
import pwd
import stat
import subprocess
import sys
import time

LABEL = "com.arenacrm.local-first-runner"
ROOT = Path("/Library/ArenaCI")
DAEMON = Path("/Library/LaunchDaemons") / (LABEL + ".plist")
FIELDS = {
    "schema", "user", "uid", "home", "runner", "runner_store", "runner_root",
    "lease_path", "work_folder", "image", "image_inode", "image_min_bytes",
    "volume", "volume_uuid", "orb", "docker", "context", "socket", "engine_id",
    "expected_daemon_sha256",
}


class Refusal(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refusal(message)


def protected(path, uid=0, private=False):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == uid,
            f"untrusted regular-file owner: {path}")
    require(not info.st_mode & (0o077 if private else 0o022),
            f"unsafe permissions: {path}")
    return info


def load_config(path):
    protected(path)
    config = json.loads(path.read_bytes())
    require(set(config) == FIELDS and config["schema"] == "arena-ci.v1",
            "unknown config schema/fields")
    require(config["user"] == "ci-runner" and type(config["uid"]) is int
            and config["uid"] > 0, "expected dedicated ci-runner account")
    for key in ("home", "runner", "runner_store", "runner_root", "lease_path",
                "work_folder", "image", "volume", "orb", "docker", "socket"):
        value = config[key]
        require(isinstance(value, str) and value.startswith("/")
                and "\n" not in value and "\x00" not in value
                and ".." not in Path(value).parts, f"invalid absolute path: {key}")
    require(config["home"] == "/Users/ci-runner", "unexpected worker home")
    require(config["context"] == "orbstack", "unexpected Docker context")
    require(config["socket"] == config["home"] + "/.orbstack/run/docker.sock",
            "unexpected worker Docker socket")
    require(Path(config["runner_store"]).parent == Path("/nix/store"),
            "runner_store must be the existing runner's store closure root")
    require(config["image"] == config["home"] + "/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw",
            "expected original OrbStack datastore path; no alternate/fallback datastore")
    for key in ("image_inode", "image_min_bytes"):
        require(type(config[key]) is int and config[key] > 0, f"invalid {key}")
    for key in ("volume_uuid", "engine_id", "expected_daemon_sha256"):
        require(isinstance(config[key], str) and config[key], f"missing {key}")
    return config


class Host:
    def run(self, args, timeout=15):
        # Never leak Docker/OrbStack output, which may contain private details.
        env = {k: v for k, v in os.environ.items() if not k.startswith("DOCKER_")}
        try:
            result = subprocess.run(args, env=env, capture_output=True,
                                    timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise Refusal(f"dependency unavailable/timed out: {Path(args[0]).name}") from exc
        require(result.returncode == 0, f"dependency failed: {Path(args[0]).name}")
        return result.stdout

    def account(self, config):
        account = pwd.getpwnam(config["user"])
        require(os.getuid() == config["uid"] == account.pw_uid
                and account.pw_dir == config["home"]
                and os.environ.get("HOME") == config["home"],
                "account/HOME mismatch; never start OrbStack as root or desktop user")

    def image(self, config):
        image = Path(config["image"])
        info = image.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == config["uid"]
                and info.st_ino == config["image_inode"]
                and info.st_size >= config["image_min_bytes"],
                "original OrbStack image missing/replaced/truncated or wrong owner; do not initialize")
        volume = Path(config["volume"])
        require(info.st_dev == volume.stat().st_dev,
                "OrbStack image is not on the pinned storage volume")
        data = plistlib.loads(self.run(["/usr/sbin/diskutil", "info", "-plist", str(volume)]))
        require(data.get("VolumeUUID", "").upper() == config["volume_uuid"].upper()
                and data.get("Internal") is True and data.get("FilesystemType") == "apfs"
                and data.get("MountPoint") == str(volume),
                "storage volume identity/mount mismatch; do not initialize")

    def socket(self, config):
        info = Path(config["socket"]).lstat()
        require(stat.S_ISSOCK(info.st_mode) and info.st_uid == config["uid"],
                "configured Docker socket missing or wrong owner/type")

    def image_open(self, config):
        fields = self.run(["/usr/sbin/lsof", "-Fpcu", "--", config["image"]]).decode().splitlines()
        processes = []
        current = {}
        for field in fields:
            if field.startswith("p"):
                if current:
                    processes.append(current)
                current = {}
            if field:
                current[field[0]] = field[1:]
        processes.append(current)
        require(any(item.get("u") == str(config["uid"])
                    and item.get("c", "").startswith("OrbStack") for item in processes),
                "pinned original image not open by worker OrbStack; refuse alternate datastore")


def guard(config, host):
    host.account(config)
    host.image(config)
    for key in ("orb", "docker", "runner"):
        require(os.access(config[key], os.X_OK), f"dependency unavailable: {key}")
    require(Path(config["runner"]).resolve().is_relative_to(Path(config["runner_store"])),
            "existing runner no longer resolves inside its pinned closure")


def engine(config, host):
    host.socket(config)
    context = json.loads(host.run([config["docker"], "context", "inspect", config["context"]]))
    require(len(context) == 1 and context[0].get("Name") == config["context"]
            and context[0].get("Endpoints", {}).get("docker", {}).get("Host")
            == "unix://" + config["socket"], "Docker context endpoint mismatch")
    data = json.loads(host.run([config["docker"], "--context", config["context"],
                                "info", "--format", "{{json .}}"] ))
    require(data.get("ID") == config["engine_id"]
            and data.get("OSType") == "linux"
            and data.get("Architecture") == "aarch64"
            and data.get("OperatingSystem") == "OrbStack",
            "Docker engine identity/platform mismatch; do not reset or re-register")
    host.image_open(config)


def ready(config, host, start=False, clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + 180
    # A missing executable can be a late-mounted Nix profile, but identity
    # failures must never be retried into a datastore initialization.
    while True:
        host.account(config)
        host.image(config)
        if all(os.access(config[key], os.X_OK) for key in ("orb", "docker", "runner")):
            break
        require(start and clock() < deadline, "runtime dependency unavailable; inspect Nix mount/profile")
        sleep(2)
    guard(config, host)
    if start:
        host.run([config["orb"], "start"], timeout=60)
    while True:
        guard(config, host)
        try:
            engine(config, host)
            return
        except Refusal as exc:
            # Wrong endpoint/engine is never a transient readiness condition.
            if "mismatch" in str(exc) or not start or clock() >= deadline:
                raise
            sleep(2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("mode", choices=("start", "check"))
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        ready(config, Host(), start=args.mode == "start")
        if args.mode == "start":
            print("arena-ci: pinned storage and engine ready; exec existing registered runner", flush=True)
            os.execv(config["runner"], [config["runner"]])
        print("arena-ci: job-start readiness passed", flush=True)
    except (Refusal, OSError, ValueError, KeyError, TypeError) as exc:
        # Do not include external output or parsed configuration values.
        message = str(exc) if isinstance(exc, Refusal) else type(exc).__name__
        print(f"arena-ci: readiness refused: {message}; inspect config/storage/Nix/OrbStack, preserve data", file=sys.stderr)
        return 75
    return 0


if __name__ == "__main__":
    sys.exit(main())
