"""Feature-only, journalled installation of the declared Nix review profile."""

import argparse
import base64
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import socket
import stat
import subprocess
import tempfile
import time
import uuid

LABEL = "dev.dmitri.hunk-turn-review"


def parents(path):
    # Include links reached through other links, while permitting legitimate
    # Home Manager mappings and directories created later in the transaction.
    pending = list(path.parent.absolute().parts[1:])
    current = Path("/")
    links = []
    while pending:
        part = pending.pop(0)
        if part == "..":
            current = current.parent
            continue
        if part == ".":
            continue
        current = current / part
        if current.is_symlink():
            if len(links) >= 40:
                raise RuntimeError(f"Parent symlink cycle: {path}")
            target = os.readlink(current)
            links.append({"path": str(current), "target": target})
            destination = Path(target)
            current = Path("/") if destination.is_absolute() else current.parent
            pending = (
                list(
                    destination.parts[1:]
                    if destination.is_absolute()
                    else destination.parts
                )
                + pending
            )
    return {"destination": str(path.parent.resolve()), "links": links}


def verify_parents(change):
    if "parents" not in change or parents(Path(change["path"])) != change["parents"]:
        raise RuntimeError(
            f"Configuration parent changed; preserve current owner and recovery receipt: {change['path']}"
        )


def link_snapshot(path, target):
    value = {"kind": "link", "target": target}
    source = path.parent / target
    if source.is_file():
        value["referent"] = {
            "path": str(source.resolve()),
            "parents": parents(source),
            "data": base64.b64encode(source.read_bytes()).decode(),
            "mode": stat.S_IMODE(source.stat().st_mode),
        }
    return value


def snapshot(path):
    if path.is_symlink():
        return link_snapshot(path, os.readlink(path))
    if not path.exists():
        return {"kind": "absent"}
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid():
        raise RuntimeError(f"Refusing non-owned file or directory collision: {path}")
    return {
        "kind": "file",
        "data": base64.b64encode(path.read_bytes()).decode(),
        "mode": stat.S_IMODE(st.st_mode),
    }


def content(data, mode=0o600):
    return {"kind": "file", "data": base64.b64encode(data).decode(), "mode": mode}


def captured_text(value):
    if value["kind"] == "absent":
        return ""
    source = value.get("referent", value)
    if "data" not in source:
        raise RuntimeError("Configuration symlink must reference a regular file")
    return base64.b64decode(source["data"]).decode()


def captured_mode(value, default):
    return value.get("referent", value).get("mode", default)


def verify_reference(path, value):
    if value["kind"] == "link" and link_snapshot(path, value["target"]) != value:
        raise RuntimeError(f"Symlink target changed; retained recovery receipt: {path}")


def replace(path, value, change=None, expected=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if change:
        verify_parents(change)
    directory = os.open(
        path.parent.resolve(), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    )
    temporary = ".hunk-turn-review-" + uuid.uuid4().hex
    try:
        if value["kind"] == "link":
            os.symlink(value["target"], temporary, dir_fd=directory)
        elif value["kind"] == "file":
            fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                value["mode"],
                dir_fd=directory,
            )
            with os.fdopen(fd, "wb") as file:
                os.fchmod(file.fileno(), value["mode"])
                file.write(base64.b64decode(value["data"]))
                file.flush()
                os.fsync(file.fileno())
        if change:
            verify_parents(change)
            if snapshot(path) != expected:
                raise RuntimeError(
                    f"Configuration changed before atomic replacement: {path}"
                )
            verify_reference(path, value)
        node = path.parent.stat()
        pinned = os.fstat(directory)
        if (node.st_dev, node.st_ino) != (pinned.st_dev, pinned.st_ino):
            raise RuntimeError(
                f"Configuration parent changed before atomic replacement: {path}"
            )
        if value["kind"] == "absent":
            try:
                os.unlink(path.name, dir_fd=directory)
            except FileNotFoundError:
                pass
        else:
            os.replace(temporary, path.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def private(path):
    if not path.exists():
        path.mkdir(parents=True, mode=0o700)
    st = path.lstat()
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise RuntimeError(
            f"Feature state must be an existing owner-private directory: {path}"
        )


def log_identity(path):
    node = path.lstat()
    if (
        not stat.S_ISREG(node.st_mode)
        or node.st_uid != os.getuid()
        or node.st_nlink != 1
        or stat.S_IMODE(node.st_mode) != 0o600
    ):
        raise RuntimeError(
            f"Refusing non-private file, symlink or hardlink log: {path}"
        )
    return {"device": node.st_dev, "inode": node.st_ino, "uid": node.st_uid}


def owned_logs(state, create=False):
    record = state / "logs.json"
    paths = [state / "runtime.log", state / "runtime-error.log"]
    if record.exists() or record.is_symlink():
        log_identity(record)
        ownership = json.loads(record.read_text())
        if ownership["parents"] != parents(paths[0]):
            raise RuntimeError("Log parent changed; preserve its current owner")
        for path in paths:
            if log_identity(path) != ownership["files"].get(path.name):
                raise RuntimeError(f"Log ownership changed; refusing launchd: {path}")
        return ownership
    for path in paths:
        if path.exists() or path.is_symlink():
            raise RuntimeError(f"Unverified existing log collision: {path}")
    if not create:
        return None
    ownership = {"parents": parents(paths[0]), "files": {}}
    for path in paths:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        ownership["files"][path.name] = log_identity(path)
    replace(record, content((json.dumps(ownership, indent=2) + "\n").encode()))
    return ownership


def text(path):
    return path.read_text() if path.exists() else ""


def herdr_preflight(path, manifest):
    if path is None:
        raise RuntimeError(
            "Herdr incompatible: explicit --herdr-socket for the intended running server is required; no server is created or handed off"
        )
    node = path.lstat()
    if (
        not stat.S_ISSOCK(node.st_mode)
        or node.st_uid != os.getuid()
        or node.st_mode & 0o077
    ):
        raise RuntimeError("Herdr incompatible: target socket must be owner-private")

    def request(method, params=None):
        with socket.socket(socket.AF_UNIX) as connection:
            connection.settimeout(3)
            connection.connect(str(path))
            connection.sendall(
                (
                    json.dumps(
                        {
                            "id": "installation-preflight",
                            "method": method,
                            "params": params or {},
                        }
                    )
                    + "\n"
                ).encode()
            )
            data = b""
            while b"\n" not in data:
                chunk = connection.recv(65536)
                if not chunk or len(data) > 8 * 1024 * 1024:
                    raise RuntimeError("Herdr incompatible: invalid target response")
                data += chunk
        response = json.loads(data.split(b"\n", 1)[0])
        if response.get("id") != "installation-preflight":
            raise RuntimeError("Herdr incompatible: target response identity mismatch")
        return response

    # Old artifacts do not export the contract. Fail closed until rebuilt.
    requirements = manifest.get("herdr")
    if not requirements:
        raise RuntimeError(
            "Herdr incompatible: profile lacks explicit compatibility contract; rebuild final source"
        )
    target = request("session.snapshot").get("result", {}).get("snapshot", {})
    version = target.get("version", "unknown")

    def version_tuple(value):
        if not re.fullmatch(r"\d+\.\d+\.\d+", value):
            raise RuntimeError(f"Herdr incompatible: unverified server version {value}")
        return tuple(map(int, value.split(".")))

    if version_tuple(version) < version_tuple(requirements["minVersion"]):
        raise RuntimeError(
            f"Herdr incompatible: target server {version} is below required {requirements['minVersion']}; runtime health cannot establish plugin compatibility; retain this server and arrange a reviewed manual Herdr update/handoff"
        )
    if target.get("protocol") != requirements["protocol"] or not all(
        isinstance(target.get(k), list) for k in ("panes", "layouts", "agents")
    ):
        raise RuntimeError(
            "Herdr incompatible: required protocol/layout/session capabilities unavailable"
        )
    if not isinstance(request("plugin.list").get("result", {}).get("plugins"), list):
        raise RuntimeError(
            "Herdr incompatible: native plugin registry capability unavailable"
        )
    layout = request("pane.layout", {"pane_id": "htr-installation-capability-probe"})
    if layout.get("error", {}).get("code") != "pane_not_found":
        raise RuntimeError(
            "Herdr incompatible: native pane.layout capability unverified"
        )
    return {
        "socket": str(path),
        "version": version,
        "protocol": target["protocol"],
        "capability": "read-only preflight passed",
    }


def runtime_health(path):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            node = path.lstat()
            if (
                not stat.S_ISSOCK(node.st_mode)
                or node.st_uid != os.getuid()
                or node.st_mode & 0o077
            ):
                raise RuntimeError("Runtime socket is not owner-private")
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(1)
                connection.connect(str(path))
                # Read-only protocol check, without inventing a native session.
                connection.sendall(
                    b'{"version":1,"id":"installation-health","method":"review.status","params":{}}\n'
                )
                data = b""
                while b"\n" not in data:
                    chunk = connection.recv(4096)
                    if not chunk or len(data) > 65536:
                        raise RuntimeError("Invalid runtime health response")
                    data += chunk
                response = json.loads(data)
                if (
                    response.get("version") != 1
                    or response.get("id") != "installation-health"
                    or response.get("error", {}).get("code") != "REFUSED"
                ):
                    raise RuntimeError("Runtime health protocol mismatch")
                return
        except (OSError, ValueError):
            time.sleep(0.05)
    raise RuntimeError(
        "Launchd bootstrap did not produce a healthy private review runtime"
    )


def restore(receipt, receipt_path, state, launchctl, domain):
    # A rename can succeed even when its following fsync fails. The durable
    # journal, not a list of successfully returned calls, owns recovery.
    transaction = receipt.get("transactionId", "")
    if not re.fullmatch(r"[0-9a-f]{32}", transaction):
        raise RuntimeError("Invalid recovery receipt; preserve backups")
    backup = state / "backups" / (transaction + ".json")
    log_identity(backup)
    durable = json.loads(backup.read_text())
    if any(
        receipt.get(key) != durable.get(key)
        for key in ("version", "profile", "changes", "transactionId", "logs", "herdr")
    ):
        raise RuntimeError(
            "Recovery receipt disagrees with durable backup; preserve both"
        )
    receipt = {**durable, "state": receipt["state"]}
    for change in receipt["changes"]:
        verify_parents(change)
        verify_reference(Path(change["path"]), change["before"])
        if snapshot(Path(change["path"])) not in (change["before"], change["after"]):
            raise RuntimeError(
                f"Rollback collision; preserve user edits and retained recovery receipt: {change['path']}"
            )
    service = subprocess.run(
        [launchctl, "print", domain + "/" + LABEL], capture_output=True
    )
    if service.returncode == 0:
        plist = plistlib.loads(
            base64.b64decode(receipt["changes"][-1]["after"]["data"])
        )
        program = re.search(r"(?m)^\s*program = (.+)$", service.stdout.decode())
        if not program or program.group(1).strip('"') != plist["ProgramArguments"][0]:
            raise RuntimeError(
                "Feature service executable changed; refusing to stop another owner"
            )
        subprocess.run(
            [launchctl, "bootout", domain + "/" + LABEL],
            check=True,
            capture_output=True,
        )
    for change in reversed(receipt["changes"]):
        verify_parents(change)
        path = Path(change["path"])
        current = snapshot(path)
        if current not in (change["before"], change["after"]):
            raise RuntimeError(f"Rollback collision, retained recovery receipt: {path}")
        if current == change["after"]:
            replace(path, change["before"], change, current)
    for change in receipt["changes"]:
        verify_parents(change)
        if snapshot(Path(change["path"])) != change["before"]:
            raise RuntimeError("Restoration not verified; retained recovery receipt")
        # A prior recovery may have renamed successfully and failed to sync.
        # Matching bytes alone cannot establish that restoration is durable.
        parent = Path(change["path"]).parent
        while not parent.exists():
            parent = parent.parent
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    archived = {**receipt, "state": "rolled-back"}
    replace(
        state / "backups" / (receipt["transactionId"] + "-rollback.json"),
        content((json.dumps(archived, indent=2) + "\n").encode()),
    )
    replace(receipt_path, {"kind": "absent"})


def plan(home, profile, state, herdr):
    manifest = json.loads((profile / "share/hunk-turn-review-install.json").read_text())
    if manifest["missing"]:
        raise RuntimeError(
            "Incomplete source integration: " + ", ".join(manifest["missing"])
        )
    changes = []

    def capture(path):
        location = parents(path)
        before = snapshot(path)
        if parents(path) != location:
            raise RuntimeError(f"Configuration parent changed during capture: {path}")
        return {"path": str(path), "parents": location, "before": before}

    def add(path, after, collision=False, captured=None):
        captured = captured or capture(path)
        before = captured["before"]
        if collision and before["kind"] != "absent":
            raise RuntimeError(f"Refusing existing installation collision: {path}")
        changes.append({**captured, "after": after})

    add(state / "profile", {"kind": "link", "target": str(profile)}, True)
    for relative, asset in manifest["links"].items():
        relative_path = Path(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts:
            raise RuntimeError(
                "Manifest destination must be a relative user-owned path"
            )
        source = profile / asset
        if not source.exists():
            raise RuntimeError(f"Missing declared asset: {source}")
        add(home / relative, {"kind": "link", "target": str(source)}, True)
    hooks_path = home / ".codex/hooks.json"
    hooks_capture = capture(hooks_path)
    hooks = json.loads(captured_text(hooks_capture["before"]) or '{"hooks":{}}')
    events = hooks.setdefault("hooks", {})
    for event, groups in manifest["hooks"]["hooks"].items():
        existing = events.setdefault(event, [])
        if not isinstance(existing, list):
            raise RuntimeError(f"Invalid existing Codex hook event: {event}")
        for group in groups:
            if group in existing:
                raise RuntimeError(
                    f"Codex hook fragment already present without installation receipt: {event}"
                )
            existing.append(group)
    add(
        hooks_path,
        content(
            (json.dumps(hooks, indent=2) + "\n").encode(),
            captured_mode(hooks_capture["before"], 0o600),
        ),
        captured=hooks_capture,
    )
    registry_path = home / ".config/herdr/plugins.json"
    registry_capture = capture(registry_path)
    registry_before = registry_capture["before"]
    registry = json.loads(captured_text(registry_before) or "[]")
    if not isinstance(registry, list) or any(
        p.get("plugin_id") == "hunk-turn-review" for p in registry
    ):
        raise RuntimeError(
            "Existing Herdr feature registry collision; preserve its owner"
        )
    # Let the native CLI generate its own registry shape in an isolated config.
    # Only its additive result joins the same journalled configuration transaction.
    with tempfile.TemporaryDirectory(prefix="hunk-plugin-", dir="/tmp") as directory:
        staging = Path(directory).resolve()
        (staging / "herdr").mkdir()
        (staging / "herdr/plugins.json").write_text(json.dumps(registry))
        config = staging / "herdr/config.toml"
        config.write_text("onboarding = false\n")
        (staging / "runtime").mkdir(mode=0o700)
        env = {
            **{
                key: value
                for key, value in os.environ.items()
                if not key.startswith("HERDR_")
            },
            "HOME": str(staging),
            "XDG_CONFIG_HOME": str(staging),
            "XDG_RUNTIME_DIR": str(staging / "runtime"),
            "HERDR_CONFIG_PATH": str(config),
            "HERDR_SESSION": "htr-i-" + uuid.uuid4().hex[:8],
        }
        subprocess.run(
            [herdr, "plugin", "link", str(profile / manifest["plugin"]), "--enabled"],
            env=env,
            check=True,
            capture_output=True,
        )
        updated = json.loads((staging / "herdr/plugins.json").read_text())
        added = [p for p in updated if p.get("plugin_id") == "hunk-turn-review"]
        if (
            len(added) != 1
            or not added[0].get("enabled")
            or [p for p in updated if p.get("plugin_id") != "hunk-turn-review"]
            != registry
        ):
            raise RuntimeError(
                "Native Herdr plugin link changed unrelated registry entries"
            )
        if snapshot(registry_path) != registry_before:
            raise RuntimeError("Herdr registry changed during preflight")
        verify_parents(registry_capture)
        add(
            registry_path,
            content(
                (json.dumps(updated, indent=2) + "\n").encode(),
                captured_mode(registry_before, 0o600),
            ),
            captured=registry_capture,
        )
    # Native trust state stays byte-unchanged. New commands require native approval.
    config = text(home / ".codex/config.toml")
    if not re.search(
        r"(?ms)^\[features\]\s*\n(?:(?!^\[).)*^hooks\s*=\s*true\b", config
    ):
        raise RuntimeError(
            "Enable Codex [features] hooks = true through native configuration before activation; installer never writes trust/config.toml"
        )
    env = "\n".join(
        [
            "# Declared Hunk turn-review profile. Rollback restores the prior .zshenv.",
            "export PATH=" + shlex.quote(str(state / "profile/bin")) + ':"$PATH"',
            "export HUNK_TURN_REVIEW_STATE=" + shlex.quote(str(state / "data")),
            "export HUNK_TURN_REVIEW_SOCKET="
            + shlex.quote(str(state / "data/runtime.sock")),
            "export HUNK_TURN_REVIEW_CLIENT=" + shlex.quote(manifest["client"]),
            "",
        ]
    )
    env_path = home / ".config/hunk-turn-review/session-env.sh"
    add(env_path, content(env.encode()), True)
    marker = "# hunk-turn-review managed environment"
    for shell_path in (home / ".zshenv", home / ".zshrc"):
        shell_capture = capture(shell_path)
        previous = captured_text(shell_capture["before"])
        if marker in previous:
            raise RuntimeError("Existing turn-review shell integration has no receipt")
        add(
            shell_path,
            content(
                (
                    previous
                    + "\n"
                    + marker
                    + "\n. "
                    + shlex.quote(str(env_path))
                    + "\n"
                ).encode(),
                captured_mode(shell_capture["before"], 0o644),
            ),
            captured=shell_capture,
        )
    agent = {
        "Label": LABEL,
        "ProgramArguments": [manifest["runtime"]],
        "EnvironmentVariables": {
            "HOME": str(home),
            "HUNK_TURN_REVIEW_STATE": str(state / "data"),
            "HUNK_TURN_REVIEW_SOCKET": str(state / "data/runtime.sock"),
        },
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "Umask": 0o077,
        "StandardOutPath": str(state / "runtime.log"),
        "StandardErrorPath": str(state / "runtime-error.log"),
    }
    add(
        home / "Library/LaunchAgents" / (LABEL + ".plist"),
        content(plistlib.dumps(agent)),
        True,
    )
    return changes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["plan", "activate", "rollback", "status"])
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--launchctl", default="/bin/launchctl")
    parser.add_argument(
        "--nix-store", default="/nix/var/nix/profiles/default/bin/nix-store"
    )
    parser.add_argument("--herdr", default="/opt/homebrew/bin/herdr")
    parser.add_argument(
        "--herdr-socket",
        type=Path,
        help="Exact existing target server socket; never starts or replaces a server",
    )
    args = parser.parse_args()
    home = args.home.resolve(strict=True)
    profile = args.profile.resolve(strict=True)
    state = home / ".local/state/hunk-turn-review"
    receipt_path = state / "installation.json"
    if args.action == "status":
        receipt = (
            json.loads(receipt_path.read_text()) if receipt_path.exists() else None
        )
        print(
            json.dumps(
                {
                    "installation": receipt and receipt["state"],
                    "profile": receipt and receipt["profile"],
                    "herdr": receipt and receipt.get("herdr"),
                    "runtimeHealth": receipt
                    and receipt.get("runtimeHealth", "unverified"),
                    "workflowAcceptance": "pending native acceptance",
                    "nativeTrust": "Inspect and approve exact new commands in native Codex; never bypass trust",
                },
                indent=2,
            )
        )
        return
    if args.action == "plan":
        compatibility = herdr_preflight(
            args.herdr_socket,
            json.loads((profile / "share/hunk-turn-review-install.json").read_text()),
        )
        changes = plan(home, profile, state, args.herdr)
        print(
            json.dumps(
                {
                    "profile": str(profile),
                    "paths": [c["path"] for c in changes],
                    "nativeTrust": "Manual native approval required",
                    "activation": "No changes made",
                    "herdr": compatibility,
                    "runtimeHealth": "not checked by plan",
                    "workflowAcceptance": "pending native acceptance",
                },
                indent=2,
            )
        )
        return
    private(state)
    lock = state / "installation.lock"
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        domain = f"gui/{os.getuid()}"
        if args.action == "rollback":
            if not receipt_path.exists():
                raise RuntimeError("No feature installation receipt to roll back")
            receipt = json.loads(receipt_path.read_text())
            restore(receipt, receipt_path, state, args.launchctl, domain)
            print(
                "Feature rolled back; durable reviews, notes, outbox, backups, and Nix build generations retained."
            )
            return
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text())
            if receipt["state"] == "installing":
                restore(receipt, receipt_path, state, args.launchctl, domain)
                receipt = None
            if (
                receipt
                and receipt["state"] == "installed"
                and receipt["profile"] == str(profile)
                and all(
                    parents(Path(c["path"])) == c.get("parents")
                    for c in receipt["changes"]
                )
                and all(
                    snapshot(Path(c["path"])) == c["after"] for c in receipt["changes"]
                )
            ):
                herdr_preflight(
                    args.herdr_socket,
                    json.loads(
                        (profile / "share/hunk-turn-review-install.json").read_text()
                    ),
                )
                owned_logs(state)
                print(
                    "Exact feature profile already installed; native trust and live acceptance remain separate."
                )
                return
            if receipt:
                raise RuntimeError(
                    "Feature already has an installation receipt; inspect status and explicitly roll back before changing it"
                )
        compatibility = herdr_preflight(
            args.herdr_socket,
            json.loads((profile / "share/hunk-turn-review-install.json").read_text()),
        )
        changes = plan(home, profile, state, args.herdr)
        owned_logs(state)
        private(state / "data")
        socket_path = state / "data/runtime.sock"
        if socket_path.exists():
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(1)
                try:
                    connection.connect(str(socket_path))
                except OSError:
                    pass  # Stale files are handled by the source-owned runtime.
                else:
                    raise RuntimeError(
                        "An existing review runtime owns the private socket; refusing takeover"
                    )
        private(state / "hunk-runtime")
        private(state / "hunk-config")
        private(state / "hunk-config/hunk")
        # An existing daemon is never restarted or taken over.
        if (
            subprocess.run(
                [args.launchctl, "print", domain + "/" + LABEL], capture_output=True
            ).returncode
            == 0
        ):
            raise RuntimeError(
                "Existing feature launchd service has no receipt; refusing takeover"
            )
        logs = owned_logs(state, create=True)
        receipt = {
            "version": 1,
            "state": "installing",
            "profile": str(profile),
            "changes": changes,
            "transactionId": uuid.uuid4().hex,
            "logs": logs,
            "herdr": compatibility,
        }
        private(state / "backups")
        private(state / "generations")
        backup = state / "backups" / (receipt["transactionId"] + ".json")
        replace(backup, content((json.dumps(receipt, indent=2) + "\n").encode()))
        replace(receipt_path, content((json.dumps(receipt, indent=2) + "\n").encode()))
        try:
            for change in changes:
                verify_parents(change)
                path = Path(change["path"])
                if snapshot(path) != change["before"]:
                    raise RuntimeError(
                        f"Configuration changed during transaction: {path}"
                    )
                replace(path, change["after"], change, change["before"])
            # Retain the exact declaratively built profile while launchd uses it.
            # This adds a feature GC root, without changing system/user package profiles.
            subprocess.run(
                [
                    args.nix_store,
                    "--add-root",
                    str(state / "generations" / receipt["transactionId"]),
                    "--indirect",
                    "--realise",
                    str(profile),
                ],
                check=True,
                capture_output=True,
            )
            owned_logs(state)
            herdr_preflight(
                args.herdr_socket,
                json.loads(
                    (profile / "share/hunk-turn-review-install.json").read_text()
                ),
            )
            subprocess.run(
                [
                    args.launchctl,
                    "bootstrap",
                    domain,
                    str(home / "Library/LaunchAgents" / (LABEL + ".plist")),
                ],
                check=True,
                capture_output=True,
            )
            owned_logs(state)
            runtime_health(state / "data/runtime.sock")
        except BaseException:
            restore(receipt, receipt_path, state, args.launchctl, domain)
            raise
        receipt["state"] = "installed"
        receipt["runtimeHealth"] = "healthy-at-installation"
        replace(receipt_path, content((json.dumps(receipt, indent=2) + "\n").encode()))
        print(
            "Feature profile installed; native Codex approval of exact additive hook commands remains required. Fresh shell and live acceptance remain separate."
        )


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or b"").decode(errors="replace").strip()
        raise SystemExit(
            f"Feature command failed ({error.returncode}): {error.cmd[0]}: {detail[:2000]}"
        )
    except Exception as error:
        raise SystemExit(str(error))
