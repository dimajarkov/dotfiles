"""External-store guard contract. Run with /usr/bin/python3 on macOS."""
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "home/.local/bin/owc-container-ready"


class ExternalStorageGuard(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.config = self.home / ".orbstack"
        self.config.mkdir()
        self.mount = self.home / "volume"
        self.target = self.mount / "20_PROJECTS/Development/OrbStack"
        self.target.mkdir(parents=True)
        (self.target / "data.img.raw").write_bytes(b"synthetic")
        self.set_config(str(self.target))
        (self.config / "internal-only-verified.json").write_text(json.dumps({
            "verified": True, "data_dir": str(self.target)
        }))
        # Only the platform identity response is substituted, in a test copy.
        # Production contains no environment-controlled bypass.
        self.identity = self.home / "identity.plist"
        self.set_identity(False)
        probe = self.home / "diskutil"
        probe.write_text('#!/bin/sh\nexec /bin/cat "' + str(self.identity) + '"\n')
        probe.chmod(0o755)
        self.guard = self.home / "guard"
        self.guard.write_text(SOURCE.read_text().replace("/usr/sbin/diskutil", str(probe)).replace("/Volumes/OWC Envoy Ultra", str(self.mount)))
        self.guard.chmod(0o755)

    def set_config(self, path):
        (self.config / "vmconfig.json").write_text(json.dumps({"data_dir": path}))

    def set_identity(self, internal):
        self.identity.write_bytes(plistlib.dumps({"Internal": internal, "Writable": True, "VolumeUUID": "17EE0606-3007-4185-B429-A99781BDCBE8", "MountPoint": str(self.mount), "FilesystemType": "apfs"}))

    def check(self, expected):
        result = subprocess.run([str(self.guard)], env={**os.environ, "HOME": str(self.home)},
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stderr)

    def test_verified_external(self):
        self.check(0)

    def test_internal(self):
        self.set_identity(True)
        self.check(78)

    def test_unknown_identity(self):
        self.identity.write_bytes(plistlib.dumps({"Writable": True}))
        self.check(78)

    def test_missing_image(self):
        (self.target / "data.img.raw").unlink()
        self.check(78)

    def test_conflicting_source(self):
        self.set_config("/Volumes/another-drive/store")
        self.check(78)

    def test_retained_old_migration_marker(self):
        (self.config / "internal-only-migration.pending").touch()
        self.check(0)

    def test_no_internal_copy_required(self):
        (self.config / "internal-only-verified.json").unlink()
        self.check(0)

    def test_store_symlink(self):
        other = self.home / "redirected"
        self.target.rename(other)
        self.target.symlink_to(other, target_is_directory=True)
        self.check(78)

    def test_image_symlink(self):
        image = self.target / "data.img.raw"
        image.rename(self.home / "redirected-image")
        image.symlink_to(self.home / "redirected-image")
        self.check(78)

    def test_config_only_interlock(self):
        (self.target / "data.img.raw").unlink()
        self.target.rmdir()
        self.target.write_text("blocked")
        self.check(78)


if __name__ == "__main__":
    unittest.main()
