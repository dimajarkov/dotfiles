import ctypes
import errno
import importlib.util
import os
import struct
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HELPER = Path(__file__).resolve().parents[1] / "home/.agents/skills/browser-routing/scripts/browser-inspect.py"
spec = importlib.util.spec_from_file_location("browser_maintenance_inspection", HELPER)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class ProfileInventoryTests(unittest.TestCase):
    def inventory(self, probe, libc=None):
        def list_pids(output, _size):
            if output is not None:
                output[0] = 4312
            return 1
        proc = SimpleNamespace(proc_listallpids=list_pids, proc_pidinfo=probe)
        with patch.object(inspection, "kernel", return_value=(libc, proc)):
            return inspection.profile_users("/private/tmp/owned-profile")

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

    def profile_arguments(self):
        data = struct.pack("=i", 2) + b"/executable\0\0/executable\0--user-data-dir=/private/tmp/owned-profile\0"
        def sysctl(_mib, _count, output, length, _input, _input_size):
            if output is None:
                length._obj.value = len(data)
            else:
                ctypes.memmove(output, data, len(data))
            return 0
        return SimpleNamespace(sysctl=sysctl)

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
