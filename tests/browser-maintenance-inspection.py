import ctypes
import errno
import importlib.util
import os
import struct
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / "home/.agents/skills/browser-routing/scripts/browser-inspect.py"
spec = importlib.util.spec_from_file_location("browser_maintenance_inspection", HELPER)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class ProfileInventoryTests(unittest.TestCase):
    def inventory(self, probe, libc=None, summary=False, profile="/private/tmp/owned-profile"):
        def list_pids(output, _size):
            if output is not None:
                output[0] = 4312
            return 1
        proc = SimpleNamespace(proc_listallpids=list_pids, proc_pidinfo=probe)
        with patch.object(inspection, "kernel", return_value=(libc, proc)):
            if summary:
                return inspection.main(["profile-users-summary", profile])
            return inspection.profile_users(profile)

    def test_diagnostic_live_procargs_permission_denied_is_categorical_and_incomplete(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size
        def denied(*_args):
            ctypes.set_errno(errno.EPERM)
            return -1
        summary = self.inventory(probe, SimpleNamespace(sysctl=denied), summary=True)
        self.assertEqual(summary, {
            "status": "incomplete",
            "counts": {"enumerated": 1, "inspected_same_uid": 1, "known_foreign_uid": 0,
                       "confirmed_gone": 0, "matching_profile": 0, "unknown_live": 1},
            "failures": [{"stage": "procargs_size", "reason": "unavailable", "errno": errno.EPERM, "count": 1}],
        })
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.inventory(probe, SimpleNamespace(sysctl=denied))

    def test_unreadable_live_pid_is_unknown_and_refuses_empty_inventory(self):
        calls = 0
        def probe(pid, _flavor, _arg, output, size):
            nonlocal calls
            calls += 1
            if calls == 1:
                ctypes.set_errno(errno.EPERM)
                return 0
            info = output._obj
            info.pid, info.uid, info.status = pid, os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size
        with self.assertRaisesRegex(ValueError, "inventory|identity"):
            self.inventory(probe)

    def test_only_fresh_esrch_can_turn_failed_probe_into_absence(self):
        calls = 0
        def probe(_pid, _flavor, _arg, _output, _size):
            nonlocal calls
            calls += 1
            ctypes.set_errno(errno.EPERM if calls == 1 else errno.ESRCH)
            return 0
        self.assertEqual(self.inventory(probe), [])
        self.assertGreaterEqual(calls, 2, "failure must be followed by a fresh kernel probe")

    def test_short_probe_without_fresh_esrch_cannot_claim_absence(self):
        def probe(_pid, _flavor, _arg, _output, _size):
            ctypes.set_errno(0)
            return 0
        with self.assertRaisesRegex(ValueError, "inventory|identity"):
            self.inventory(probe)

    def test_fresh_verified_zombie_proves_absence(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.status = pid, os.getuid(), 5
            return size
        self.assertEqual(self.inventory(probe), [])

    def profile_arguments(self, environment=b"", arguments=("--user-data-dir=/private/tmp/owned-profile",)):
        argv = ["/executable", *arguments]
        data = struct.pack("=i", len(argv)) + b"/executable\0\0"
        data += b"\0".join(arg.encode() for arg in argv) + b"\0" + environment
        def sysctl(_mib, _count, output, length, _input, _input_size):
            if output is None:
                length._obj.value = len(data)
            else:
                ctypes.memmove(output, data, len(data))
            return 0
        return SimpleNamespace(sysctl=sysctl)

    def test_relative_profile_argument_is_unknown_not_a_complete_zero_user_inventory(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size

        # The inspector's cwd makes this relative argument appear to match, but
        # the candidate process cwd is not independently known by this inventory.
        profile = os.path.realpath("profile")
        libc = self.profile_arguments(arguments=("--user-data-dir=profile",))
        summary = self.inventory(probe, libc, summary=True, profile=profile)
        self.assertEqual(summary["status"], "incomplete")
        self.assertEqual(summary["counts"]["matching_profile"], 0)
        self.assertEqual(summary["counts"]["unknown_live"], 1)
        self.assertEqual(summary["failures"], [{
            "stage": "procargs_parse", "reason": "unclassified", "errno": None, "count": 1,
        }])
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.inventory(probe, libc, profile=profile)

    def test_relative_empty_and_missing_profile_values_are_unknown(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size

        cases = (
            ("--user-data-dir", "profile"),
            ("--user-data-dir=",),
            ("--user-data-dir", ""),
            ("--user-data-dir",),
        )
        for arguments in cases:
            with self.subTest(arguments=arguments):
                libc = self.profile_arguments(arguments=arguments)
                summary = self.inventory(probe, libc, summary=True)
                self.assertEqual(summary["status"], "incomplete")
                self.assertEqual(summary["counts"]["matching_profile"], 0)
                self.assertEqual(summary["counts"]["unknown_live"], 1)
                self.assertEqual(summary["failures"][0]["stage"], "procargs_parse")
                with self.assertRaisesRegex(ValueError, "inventory"):
                    self.inventory(probe, libc)

    def test_absolute_two_argument_profile_uses_canonical_symlink_comparison(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = root / "profile"
            alias = root / "profile-alias"
            profile.mkdir()
            alias.symlink_to(profile, target_is_directory=True)
            libc = self.profile_arguments(arguments=("--user-data-dir", str(alias)))
            self.assertEqual(self.inventory(probe, libc, profile=str(profile)), [4312])
            summary = self.inventory(probe, libc, summary=True, profile=str(profile))
            self.assertEqual(summary["status"], "complete")
            self.assertEqual(summary["counts"]["matching_profile"], 1)

    def test_profile_inventory_does_not_parse_unrelated_environment_bytes(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size
        libc = self.profile_arguments(b"private-\xff-name=private-environment-marker\0")
        self.assertEqual(self.inventory(probe, libc), [4312])
        summary = self.inventory(probe, libc, summary=True)
        self.assertEqual(summary["status"], "complete")
        self.assertNotIn("private", str(summary))

    def test_foreign_uid_reuse_during_inventory_is_unknown(self):
        calls = 0
        def probe(pid, _flavor, _arg, output, size):
            nonlocal calls
            calls += 1
            info = output._obj
            uid = os.getuid() + 1000 if calls == 1 else os.getuid()
            info.pid, info.uid, info.ruid, info.status = pid, uid, uid, 2
            info.start_sec, info.start_usec = (700 if calls == 1 else 701), 3
            return size
        summary = self.inventory(probe, summary=True)
        self.assertEqual(summary["status"], "incomplete")
        self.assertEqual(summary["counts"]["unknown_live"], 1)
        self.assertEqual(summary["failures"], [{"stage": "identity_recheck", "reason": "identity_changed", "errno": None, "count": 1}])

    def test_foreign_effective_uid_with_owned_real_uid_is_unknown(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid() + 1000, os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size
        summary = self.inventory(probe, summary=True)
        self.assertEqual(summary["status"], "incomplete")
        self.assertEqual(summary["counts"]["unknown_live"], 1)
        self.assertEqual(summary["failures"][0]["reason"], "setuid")

    def test_exact_live_profile_user_is_reported(self):
        def probe(pid, _flavor, _arg, output, size):
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = 700, 3
            return size
        self.assertEqual(self.inventory(probe, self.profile_arguments()), [4312])

    def test_reused_process_start_during_profile_lookup_refuses(self):
        calls = 0
        def probe(pid, _flavor, _arg, output, size):
            nonlocal calls
            calls += 1
            info = output._obj
            info.pid, info.uid, info.ruid, info.status = pid, os.getuid(), os.getuid(), 2
            info.start_sec, info.start_usec = (700 if calls == 1 else 701), 3
            return size
        with self.assertRaisesRegex(ValueError, "inventory|identity"):
            self.inventory(probe, self.profile_arguments())


if __name__ == "__main__":
    unittest.main()
