"""Synthetic-only behavioral checks for the feature installer."""

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

INSTALLER = Path(
    os.environ.get(
        "TREEHOUSE_INSTALLER",
        Path(__file__).parent.parent / "runtime/treehouse-owned-install.py",
    )
)
spec = importlib.util.spec_from_file_location("installer", INSTALLER)
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallationTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        self.pool = self.root / "pool"
        self.pool.mkdir()
        self.profile = self.root / "profile"
        self.assets = self.profile / "share/treehouse-owned"
        self.assets.mkdir(parents=True)
        self.routes = {
            "treehouse": self.home / ".local/bin/treehouse",
            "treehouse-bin": self.home / ".local/libexec/treehouse-bin",
        }
        self.originals = {
            "treehouse": b"original wrapper\n",
            "treehouse-bin": b"original backing\n",
        }
        self.expected = {}
        for name, path in self.routes.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.originals[name])
            path.chmod(0o700)
            self.expected[name] = installer.digest(self.originals[name])
            (self.assets / name).write_bytes(b"new " + name.encode())
        (self.home / ".local/libexec/treehouse-versions").mkdir()
        manifest = {
            "schema": "treehouse.owned-artifact.v1",
            "source": "github:dimajarkov/treehouse/synthetic",
            "revision": "synthetic",
            "assets": {
                name: installer.digest((self.assets / name).read_bytes())
                for name in self.routes
            },
        }
        (self.assets / "manifest.json").write_bytes(installer.encode(manifest))
        self.policy = {
            "version": "treehouse.launch-owner.v1",
            "pool": str(self.pool),
            "route": {
                "wrapper": str(self.routes["treehouse"]),
                "backing": str(self.routes["treehouse-bin"]),
                "wrapper_sha256": self.expected["treehouse"],
                "backing_sha256": self.expected["treehouse-bin"],
            },
            "owners": ["synthetic owner"],
        }
        installer.write(
            self.pool / "treehouse-launch-policy.json", installer.encode(self.policy)
        )
        installer.write(
            self.pool / "treehouse-state.json", b'{"unrelated":{"leased":true}}\n'
        )
        for name in [
            "treehouse-launch-owner.lock",
            "treehouse-launch-admission.lock",
            "treehouse-state.lock",
        ]:
            installer.write(
                self.pool / name,
                b"",
                mode=0o644 if name == "treehouse-state.lock" else 0o600,
            )
        self.commands = []
        self.installation = installer.Installation(
            self.profile, self.home, self.pool, self.run_command
        )
        self.initial = mock.patch.object(installer, "INITIAL", self.expected)
        self.initial.start()
        self.addCleanup(self.initial.stop)

    def run_command(self, command, **kwargs):
        self.commands.append(command)
        return subprocess.CompletedProcess(
            command, 1 if command[0] == "/usr/sbin/lsof" else 0, "", ""
        )

    def test_plan_is_read_only(self):
        before = {
            str(path): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.installation.plan()
        after = {
            str(path): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(before, after)
        self.assertEqual([], self.commands)

    def test_apply_preserves_state_policy_fields_and_regular_files(self):
        state = (self.pool / "treehouse-state.json").read_bytes()
        identities = {
            name: (self.pool / name).stat().st_ino
            for name in [
                "treehouse-launch-owner.lock",
                "treehouse-launch-admission.lock",
                "treehouse-state.lock",
            ]
        }
        receipt = self.installation.apply(self.installation.plan())
        self.assertEqual(state, (self.pool / "treehouse-state.json").read_bytes())
        for name, path in self.routes.items():
            self.assertFalse(path.is_symlink())
            self.assertEqual((self.assets / name).read_bytes(), path.read_bytes())
            self.assertEqual(0o700, path.stat().st_mode & 0o777)
        policy = json.loads((self.pool / "treehouse-launch-policy.json").read_bytes())
        self.assertEqual(self.policy["owners"], policy["owners"])
        for name, inode in identities.items():
            self.assertEqual(inode, (self.pool / name).stat().st_ino)
        self.assertEqual(receipt["assets"], self.installation.plan()["assets"])
        self.assertTrue((Path(receipt["archive"]) / "state.original").is_file())

    def test_json_plan_preserves_owner_admission_state_lock_order(self):
        import fcntl

        expected = [
            "treehouse-launch-owner.lock",
            "treehouse-launch-admission.lock",
            "treehouse-state.lock",
        ]
        inodes = {(self.pool / name).stat().st_ino: name for name in expected}
        observed = []
        original = fcntl.flock

        def acquire(descriptor, operation):
            name = inodes.get(os.fstat(descriptor).st_ino)
            if name:
                observed.append(name)
            return original(descriptor, operation)

        approved = json.loads(installer.encode(self.installation.plan()))
        with mock.patch.object(installer.fcntl, "flock", acquire):
            self.installation.apply(approved)
        self.assertEqual(expected, observed)

    def test_stale_plan_refuses_before_routes_change(self):
        plan = self.installation.plan()
        (self.pool / "treehouse-state.json").write_bytes(b"new state")
        with self.assertRaisesRegex(RuntimeError, "Plan changed"):
            self.installation.apply(plan)
        self.assertEqual(
            self.originals["treehouse-bin"], self.routes["treehouse-bin"].read_bytes()
        )

    def test_nonexecutable_route_refuses(self):
        self.routes["treehouse-bin"].chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, "executable"):
            self.installation.plan()

    def test_state_drift_after_plan_check_is_not_rebased(self):
        approved = self.installation.plan()
        original_plan = self.installation.plan
        state_path = self.pool / "treehouse-state.json"

        def drift_after_check():
            plan = original_plan()
            state_path.write_bytes(b"changed by another owner")
            return plan

        with mock.patch.object(self.installation, "plan", drift_after_check):
            with self.assertRaisesRegex(RuntimeError, "Registry or policy changed"):
                self.installation.apply(approved)
        self.assertEqual(b"changed by another owner", state_path.read_bytes())
        for name, path in self.routes.items():
            self.assertEqual(self.originals[name], path.read_bytes())

    def test_unknown_owner_or_symlink_refuses(self):
        self.routes["treehouse-bin"].write_bytes(b"different owner")
        with self.assertRaisesRegex(RuntimeError, "Unknown installed owner"):
            self.installation.plan()
        self.routes["treehouse-bin"].unlink()
        self.routes["treehouse-bin"].symlink_to(self.assets / "treehouse-bin")
        with self.assertRaisesRegex(RuntimeError, "regular file"):
            self.installation.plan()

    def test_unknown_policy_fields_refuse_before_changes(self):
        policy = {**self.policy, "unknown": True}
        (self.pool / "treehouse-launch-policy.json").write_bytes(
            installer.encode(policy)
        )
        with self.assertRaisesRegex(RuntimeError, "Unknown admission policy fields"):
            self.installation.plan()
        self.assertEqual(
            self.originals["treehouse"], self.routes["treehouse"].read_bytes()
        )

    def test_lock_contention_rolls_back_without_replacing_gate(self):
        import fcntl

        path = self.pool / "treehouse-launch-owner.lock"
        with path.open("r+b") as stream:
            fcntl.flock(stream, fcntl.LOCK_SH | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                self.installation.apply(self.installation.plan())
        self.assertEqual(
            self.originals["treehouse"], self.routes["treehouse"].read_bytes()
        )
        self.assertEqual(
            self.originals["treehouse-bin"], self.routes["treehouse-bin"].read_bytes()
        )
        self.assertEqual(
            self.policy,
            json.loads((self.pool / "treehouse-launch-policy.json").read_bytes()),
        )

    def test_failed_policy_update_restores_previous_pair(self):
        original = installer.replace
        failed = False

        def fail_once(staged, target):
            nonlocal failed
            if target == self.pool / "treehouse-launch-policy.json" and not failed:
                failed = True
                raise OSError("synthetic interrupted policy replacement")
            return original(staged, target)

        with mock.patch.object(installer, "replace", fail_once):
            with self.assertRaisesRegex(OSError, "synthetic interrupted"):
                self.installation.apply(self.installation.plan())
        for name, path in self.routes.items():
            self.assertEqual(self.originals[name], path.read_bytes())
        self.assertEqual(
            self.policy,
            json.loads((self.pool / "treehouse-launch-policy.json").read_bytes()),
        )

    def test_retained_foreign_metadata_is_never_reconciled(self):
        state = (self.pool / "treehouse-state.json").read_bytes()
        self.installation.apply(self.installation.plan())
        self.assertEqual(state, (self.pool / "treehouse-state.json").read_bytes())
        self.assertFalse(
            any(
                "reconcile" in str(command) or "destroy" in str(command)
                for command in self.commands
            )
        )


class SourcePinTest(unittest.TestCase):
    def test_fork_revision_is_immutable_and_matches_artifact(self):
        default = Path(__file__).parent.parent.parent / "flake.lock"
        path = Path(os.environ.get("TREEHOUSE_DOTFILES_FLAKE_LOCK", default))
        if not path.exists():
            self.skipTest("Dotfiles pin supplied by package check")
        lock = json.loads(path.read_bytes())
        node = lock["nodes"][lock["nodes"]["root"]["inputs"]["treehouse-owned"]]
        self.assertEqual("dimajarkov", node["locked"]["owner"])
        self.assertEqual("treehouse", node["locked"]["repo"])
        self.assertRegex(node["locked"]["rev"], r"^[0-9a-f]{40}$")
        self.assertEqual(node["original"]["rev"], node["locked"]["rev"])
        manifest_path = os.environ.get("TREEHOUSE_ARTIFACT_MANIFEST")
        if manifest_path:
            manifest = json.loads(Path(manifest_path).read_bytes())
            self.assertEqual(node["locked"]["rev"], manifest["revision"])
            self.assertEqual(
                "github:dimajarkov/treehouse/" + manifest["revision"],
                manifest["source"],
            )


if __name__ == "__main__":
    unittest.main()
