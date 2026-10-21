"""Explicit update of the existing regular-file Treehouse installation.

Plan is read-only. Apply preserves policy/gates and refuses unknown provenance.
This installer does not bootstrap pools, provision admission or reconcile state.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import time
import uuid

POOL_PARENT = Path("/Volumes/OWC Envoy Ultra/20_PROJECTS/Development/Treehouse")
POOL_NAME = "arena-crm-1adf4e"
INITIAL = {
    "treehouse": "3f8b1067089d464ec28ff44659d5c27d95900e2dd9508b580464c04f1d446ecf",
    "treehouse-bin": "bde648e86384578475fc12c44178b8489610077e2d46514acc98e1a2022d54e2",
}
BLOCKER = b'#!/bin/sh\nprintf "%s\\n" "treehouse: bounded Nix installation maintenance; retry shortly" >&2\nexit 75\n'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def unique_fields(items):
    value = {}
    for key, item in items:
        if key in value:
            raise RuntimeError("Duplicate JSON field")
        value[key] = item
    return value


def syncdir(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def regular(path, private=False):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RuntimeError(f"Expected owned regular file: {path}")
    mode = stat.S_IMODE(info.st_mode)
    if mode & 0o022 or (private and mode != 0o600):
        raise RuntimeError(f"Unexpected permissions: {path}")
    data = path.read_bytes()
    return data, {
        "sha256": digest(data),
        "device": info.st_dev,
        "inode": info.st_ino,
        "uid": info.st_uid,
        "gid": info.st_gid,
        "mode": mode,
    }


def write(path, data, mode=0o600, owner=None):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)
        stream.flush()
        if owner:
            os.fchown(stream.fileno(), owner["uid"], owner["gid"])
        os.fchmod(stream.fileno(), mode)
        os.fsync(stream.fileno())
    syncdir(path.parent)


def replace(staged, target):
    os.replace(staged, target)
    syncdir(target.parent)


class Installation:
    def __init__(self, profile, home, pool, run=subprocess.run):
        self.profile = profile.resolve()
        self.home = home
        self.pool = pool
        self.run = run
        self.routes = {
            "treehouse": home / ".local/bin/treehouse",
            "treehouse-bin": home / ".local/libexec/treehouse-bin",
        }
        self.assets = self.profile / "share/treehouse-owned"
        self.policy = pool / "treehouse-launch-policy.json"
        self.state = pool / "treehouse-state.json"
        self.current = home / ".local/state/treehouse-owned/current.json"
        self.manifest = json.loads((self.assets / "manifest.json").read_bytes())
        if self.manifest["schema"] != "treehouse.owned-artifact.v1":
            raise RuntimeError("Unknown artifact manifest")
        for name in self.routes:
            if (
                digest((self.assets / name).read_bytes())
                != self.manifest["assets"][name]
            ):
                raise RuntimeError("Artifact hash mismatch")

    def plan(self):
        routes = {name: regular(path)[1] for name, path in self.routes.items()}
        if any(value["mode"] & 0o111 == 0 for value in routes.values()):
            raise RuntimeError("Installed routes must remain executable")
        hashes = {name: value["sha256"] for name, value in routes.items()}
        known = hashes == INITIAL
        provenance = None
        if self.current.exists() or self.current.is_symlink():
            previous_bytes, provenance = regular(self.current, private=True)
            previous = json.loads(previous_bytes)
            known = (
                previous["schema"] == "treehouse.owned-installation.v1"
                and previous["assets"] == hashes
            )
        if not known:
            raise RuntimeError(
                "Unknown installed owner provenance; inspect before updating"
            )
        policy_bytes, policy_identity = regular(self.policy, private=True)
        policy = json.loads(policy_bytes, object_pairs_hook=unique_fields)
        if set(policy) != {"version", "pool", "route", "owners"} or set(
            policy["route"]
        ) != {"wrapper", "backing", "wrapper_sha256", "backing_sha256"}:
            raise RuntimeError("Unknown admission policy fields")
        owners = policy["owners"]
        if (
            not isinstance(owners, list)
            or not owners
            or any(not isinstance(owner, str) or not owner for owner in owners)
            or len(set(owners)) != len(owners)
        ):
            raise RuntimeError("Unknown admission policy owner scope")
        if policy["version"] != "treehouse.launch-owner.v1" or policy["pool"] != str(
            self.pool
        ):
            raise RuntimeError("Foreign admission policy")
        for name, field in [("treehouse", "wrapper"), ("treehouse-bin", "backing")]:
            if (
                policy["route"][field] != str(self.routes[name])
                or policy["route"][field + "_sha256"] != hashes[name]
            ):
                raise RuntimeError("Installed routes and policy disagree")
        locks = {
            name: regular(self.pool / name, private=name != "treehouse-state.lock")[1]
            for name in [
                "treehouse-launch-owner.lock",
                "treehouse-launch-admission.lock",
                "treehouse-state.lock",
            ]
        }
        return {
            "schema": "treehouse.owned-plan.v1",
            "profile": str(self.profile),
            "source": self.manifest["source"],
            "revision": self.manifest["revision"],
            "assets": self.manifest["assets"],
            "routes": routes,
            "policy": policy_identity,
            "locks": locks,
            "state": regular(self.state)[1],
            "pool": str(self.pool),
            "provenance": provenance,
        }

    def drain(self, links):
        deadline = time.monotonic() + 30
        while True:
            result = self.run(
                ["/usr/sbin/lsof", "-t", "--", *map(str, links)],
                capture_output=True,
                text=True,
            )
            if result.returncode not in [0, 1]:
                raise RuntimeError("Cannot inspect old executable users")
            users = [
                line for line in result.stdout.splitlines() if line != str(os.getpid())
            ]
            processes = self.run(
                ["/bin/ps", "-axo", "pid=,comm="],
                capture_output=True,
                text=True,
                check=True,
            ).stdout
            active = [
                line
                for line in processes.splitlines()
                if line.strip().endswith(("/treehouse", "/treehouse-bin"))
            ]
            if not users and not active:
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    "Existing Treehouse commands did not drain voluntarily"
                )
            time.sleep(0.5)

    def apply(self, approved):
        # Serialize this installer before inspecting or replacing shared routes.
        directory = self.current.parent
        if directory.is_symlink():
            raise RuntimeError("Installer state directory must not be symlinked")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if (
            directory.stat().st_uid != os.getuid()
            or stat.S_IMODE(directory.stat().st_mode) != 0o700
        ):
            raise RuntimeError("Private owned installer directory required")
        lock_path = directory / "install.lock"
        descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            lock_info = regular(lock_path, private=True)[1]
            held = os.fstat(descriptor)
            if (held.st_dev, held.st_ino) != (lock_info["device"], lock_info["inode"]):
                raise RuntimeError("Installer lock identity changed")
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self._apply(approved)
        finally:
            os.close(descriptor)

    def _apply(self, approved):
        if approved != self.plan():
            raise RuntimeError("Plan changed; inspect a new plan")
        original_provenance = (
            regular(self.current, private=True)[0] if self.current.exists() else None
        )
        originals = {name: regular(path)[0] for name, path in self.routes.items()}
        old_policy = regular(self.policy, private=True)[0]
        state = regular(self.state)[0]
        versions = self.home / ".local/libexec/treehouse-versions"
        if versions.is_symlink() or not versions.is_dir():
            raise RuntimeError("Existing regular version archive required")
        archive = versions / ("nix-owned-" + uuid.uuid4().hex)
        archive.mkdir(mode=0o700)
        if any(
            path.parent.stat().st_dev != archive.stat().st_dev
            for path in self.routes.values()
        ):
            raise RuntimeError(
                "Installation routes must share the private archive filesystem"
            )
        links = []
        for name, path in self.routes.items():
            write(archive / (name + ".original"), originals[name], 0o400)
            link = archive / (name + ".original-inode")
            os.link(path, link)
            links.append(link)
        write(archive / "policy.original", old_policy)
        write(archive / "state.original", state)
        write(archive / "approved-plan.json", encode(approved))
        # Keep the package and its installer available independently of flake GC.
        self.run(
            [
                "nix-store",
                "--add-root",
                str(archive / "profile"),
                "--indirect",
                "--realise",
                str(self.profile),
            ],
            check=True,
            capture_output=True,
        )
        changed, locks = [], []
        candidate = json.loads(old_policy)
        candidate["route"]["wrapper_sha256"] = self.manifest["assets"]["treehouse"]
        candidate["route"]["backing_sha256"] = self.manifest["assets"]["treehouse-bin"]
        new_policy = encode(candidate)
        updated_policy = False
        receipt_bytes = None
        try:
            for name, path in self.routes.items():
                if regular(path)[1] != approved["routes"][name]:
                    raise RuntimeError("Installed route changed")
                stage = archive / (name + ".blocker")
                write(
                    stage,
                    BLOCKER,
                    approved["routes"][name]["mode"],
                    approved["routes"][name],
                )
                changed.append(name)
                replace(stage, path)
            self.drain(links)
            # Reviewed JSON is key-sorted; lock ordering must not depend on it.
            for name in [
                "treehouse-launch-owner.lock",
                "treehouse-launch-admission.lock",
                "treehouse-state.lock",
            ]:
                expected = approved["locks"][name]
                path = self.pool / name
                if regular(path, private=name != "treehouse-state.lock")[1] != expected:
                    raise RuntimeError("Pool lock identity changed")
                descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
                locks.append(descriptor)
                held = os.fstat(descriptor)
                if (held.st_dev, held.st_ino) != (
                    expected["device"],
                    expected["inode"],
                ):
                    raise RuntimeError("Pool lock handle identity changed")
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if regular(path, private=name != "treehouse-state.lock")[1] != expected:
                    raise RuntimeError("Named pool lock changed")
            if (
                regular(self.state)[1] != approved["state"]
                or regular(self.policy, private=True)[1] != approved["policy"]
            ):
                raise RuntimeError("Registry or policy changed during maintenance")
            for name in ["treehouse-bin", "treehouse"]:
                path = self.routes[name]
                if path.read_bytes() != BLOCKER:
                    raise RuntimeError("Maintenance route changed owner")
                stage = archive / (name + ".candidate")
                write(
                    stage,
                    (self.assets / name).read_bytes(),
                    approved["routes"][name]["mode"],
                    approved["routes"][name],
                )
                replace(stage, path)
                if name == "treehouse-bin":
                    stage = self.policy.with_name(self.policy.name + "." + archive.name)
                    write(stage, new_policy)
                    updated_policy = True
                    replace(stage, self.policy)
            if regular(self.state)[1] != approved["state"]:
                raise RuntimeError("Registry changed under exclusive maintenance")
            for name, path in self.routes.items():
                actual = regular(path)[1]
                expected = approved["routes"][name]
                if actual["sha256"] != self.manifest["assets"][name] or any(
                    actual[field] != expected[field] for field in ["uid", "gid", "mode"]
                ):
                    raise RuntimeError(
                        "Installed artifact or ownership verification failed"
                    )
            if regular(self.policy, private=True)[0] != new_policy:
                raise RuntimeError("Installed policy verification failed")
            for name, expected in approved["locks"].items():
                if (
                    regular(self.pool / name, private=name != "treehouse-state.lock")[1]
                    != expected
                ):
                    raise RuntimeError("Pool lock identity changed during installation")
            receipt = {
                "schema": "treehouse.owned-installation.v1",
                "assets": self.manifest["assets"],
                "source": self.manifest["source"],
                "revision": self.manifest["revision"],
                "profile": str(self.profile),
                "archive": str(archive),
                "registryUnchanged": True,
            }
            receipt_bytes = encode(receipt)
            write(archive / "activation.json", receipt_bytes)
            stage = self.current.with_name("current." + archive.name)
            write(stage, receipt_bytes)
            replace(stage, self.current)
            return receipt
        except BaseException:
            # Never overwrite an external edit or claim rollback after a state mutation.
            if self.state.read_bytes() != state:
                raise RuntimeError(
                    f"Registry changed; retain blocked routes and recovery archive {archive}"
                ) from None
            current_provenance = (
                regular(self.current, private=True)[0]
                if self.current.exists()
                else None
            )
            if current_provenance != original_provenance:
                if current_provenance != receipt_bytes:
                    raise RuntimeError(
                        f"Provenance owner changed; preserve {archive}"
                    ) from None
                if original_provenance is None:
                    self.current.unlink()
                    syncdir(self.current.parent)
                else:
                    stage = self.current.with_name("current.rollback-" + archive.name)
                    write(stage, original_provenance)
                    replace(stage, self.current)
            if updated_policy and self.policy.read_bytes() != old_policy:
                if self.policy.read_bytes() != new_policy:
                    raise RuntimeError(
                        f"Policy owner changed; preserve {archive}"
                    ) from None
                stage = self.policy.with_name(
                    self.policy.name + ".rollback-" + archive.name
                )
                write(stage, old_policy)
                replace(stage, self.policy)
            for name in reversed(changed):
                path = self.routes[name]
                current = regular(path)[0]
                if current == originals[name]:
                    continue
                if current not in [BLOCKER, (self.assets / name).read_bytes()]:
                    raise RuntimeError(
                        f"Route owner changed; preserve {archive}"
                    ) from None
                stage = archive / (name + ".rollback")
                write(
                    stage,
                    originals[name],
                    approved["routes"][name]["mode"],
                    approved["routes"][name],
                )
                replace(stage, path)
            write(
                archive / "failure.json",
                encode({"status": "rolled-back", "registryUnchanged": True}),
            )
            raise
        finally:
            for descriptor in reversed(locks):
                os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True, type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("plan")
    apply = commands.add_parser("apply")
    apply.add_argument("--plan", required=True, type=Path)
    args = parser.parse_args()
    home = Path.home()
    logical = home / ".treehouse"
    if (
        not logical.is_symlink()
        or logical.resolve(strict=True) != POOL_PARENT
        or os.stat(home).st_dev == os.stat(logical).st_dev
    ):
        raise RuntimeError(
            "Expected mounted external Treehouse storage and original symlink"
        )
    install = Installation(args.profile, home, POOL_PARENT / POOL_NAME)
    if args.command == "plan":
        print(encode(install.plan()).decode(), end="")
    else:
        print(
            encode(install.apply(json.loads(args.plan.read_bytes()))).decode(), end=""
        )


if __name__ == "__main__":
    main()
