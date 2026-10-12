import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "home/.agents/skills/browser-routing/scripts/browser-inspect.py"
spec = importlib.util.spec_from_file_location("browser_inspection", HELPER)
inspection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspection)


class ChromeSignatureTests(unittest.TestCase):
    def verify(self, mode=0o775, uid=None, gid=80):
        stat = SimpleNamespace(st_mode=mode, st_uid=os.getuid() if uid is None else uid,
                               st_gid=gid)
        with patch.object(inspection, "kernel"), \
                patch.object(inspection.os.path, "realpath", side_effect=lambda path: path), \
                patch.object(inspection.os.path, "isfile", return_value=True), \
                patch.object(inspection.os, "stat", return_value=stat), \
                patch.object(inspection, "command", return_value="") as command:
            result = inspection.main(["trusted-chrome"])
            return result, command.call_args.args[0]

    def test_signed_owner_admin_bundle_uses_inline_requirement(self):
        result, command = self.verify()
        self.assertTrue(result)
        self.assertEqual(command[:3], ["/usr/bin/codesign", "--verify", "-R"])
        self.assertTrue(command[3].startswith("=anchor apple generic"))
        self.assertIn('identifier "com.google.Chrome"', command[3])
        self.assertIn('"EQHXZ8M8AV"', command[3])
        self.assertNotIn("--strict", command)

    def test_world_writable_or_untrusted_group_or_owner_is_refused(self):
        for kwargs in [{"mode": 0o777}, {"gid": 20}, {"uid": os.getuid() + 1000}]:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    self.verify(**kwargs)


if __name__ == "__main__":
    unittest.main()
