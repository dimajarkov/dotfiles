"""Small behavioral tests. No launchctl, OrbStack, Nix daemon or live runner calls."""

import importlib.util
import json
import os
from pathlib import Path
import plistlib
import selectors
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ASSETS = Path(os.environ.get("ARENA_CI_ASSETS", Path(__file__).parents[1] / "runtime"))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


install = module("arena_install", ASSETS / "arena-ci-install.py")
runtime = install.runtime


def config():
    home = "/Users/ci-runner"
    return {
        "schema": "arena-ci.v1", "user": "ci-runner", "uid": 502, "home": home,
        "runner": "/nix/store/existing-runner/bin/arena-local-first-runner",
        "runner_store": "/nix/store/existing-runner", "runner_root": home + "/runner",
        "lease_path": home + "/checkout", "work_folder": home + "/.local/share/arena-actions-work",
        "image": home + "/Library/Group Containers/HUAQ24HBR6.dev.orbstack/data/data.img.raw",
        "image_inode": 123, "image_min_bytes": 32, "volume": "/System/Volumes/Data",
        "volume_uuid": "original-volume", "orb": "/usr/local/bin/orb", "docker": "/usr/local/bin/docker",
        "context": "orbstack", "socket": home + "/.orbstack/run/docker.sock",
        "engine_id": "original-engine", "expected_daemon_sha256": "original-hash",
    }


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class EngineHost:
    def __init__(self, value):
        self.config = value
        self.calls = []
        self.engine_id = "original-engine"
        self.endpoint = "unix://" + value["socket"]
        self.failures = 0
        self.account_ok = True
        self.image_ok = True
        self.image_open_ok = True

    def account(self, _config):
        runtime.require(self.account_ok, "account mismatch")

    def image(self, _config):
        runtime.require(self.image_ok, "storage identity mismatch")

    def socket(self, _config):
        pass

    def image_open(self, _config):
        runtime.require(self.image_open_ok, "pinned image mismatch")

    def run(self, args, timeout=15):
        self.calls.append(args)
        if args[:2] == [self.config["orb"], "start"]:
            return b""
        if "inspect" in args:
            return json.dumps([{"Name": "orbstack", "Endpoints": {"docker": {"Host": self.endpoint}}}]).encode()
        if self.failures:
            self.failures -= 1
            raise runtime.Refusal("dependency failed: docker")
        return json.dumps({"ID": self.engine_id, "OSType": "linux", "Architecture": "aarch64",
                           "OperatingSystem": "OrbStack"}).encode()


class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.config = config()
        self.host = EngineHost(self.config)
        self.clock = Clock()

    def ready(self, start=True, available=lambda _path, _mode: True):
        with patch.object(runtime.os, "access", side_effect=available):
            runtime.ready(self.config, self.host, start=start, clock=self.clock, sleep=self.clock.sleep)

    def test_late_dependency_and_engine_recovery_start_once(self):
        self.host.failures = 2
        self.ready(available=lambda _path, _mode: self.clock.now >= 4)
        self.assertGreaterEqual(self.clock.now, 8)
        self.assertEqual(self.host.calls.count([self.config["orb"], "start"]), 1)
        self.assertFalse(any("reset" in call or "delete" in call for call in self.host.calls))

    def test_missing_dependency_bounded_and_retryable_without_engine_start(self):
        with self.assertRaisesRegex(runtime.Refusal, "dependency unavailable"):
            self.ready(available=lambda _path, _mode: False)
        self.assertEqual(self.clock.now, 180)
        self.assertEqual(self.host.calls, [])

    def test_engine_timeout_is_bounded_and_next_start_can_recover(self):
        self.host.failures = 1000
        with self.assertRaisesRegex(runtime.Refusal, "dependency failed"):
            self.ready()
        self.assertEqual(self.clock.now, 180)
        self.host.failures = 0
        self.ready()
        self.assertEqual(self.host.calls.count([self.config["orb"], "start"]), 2)

    def test_job_hook_returns_retryable_status_without_starting_engine(self):
        with patch.object(runtime, "load_config", return_value=self.config), \
                patch.object(runtime, "Host", return_value=self.host), \
                patch.object(runtime.os, "access", return_value=False), \
                patch.object(runtime.sys, "argv", ["runtime", "--config", "/private/config", "check"]), \
                patch("builtins.print") as output:
            self.assertEqual(runtime.main(), 75)
        self.assertIn("dependency unavailable", output.call_args.args[0])
        self.assertEqual(self.host.calls, [])

    def test_account_and_storage_fail_before_start(self):
        for field in ("account_ok", "image_ok"):
            with self.subTest(field=field):
                setattr(self.host, field, False)
                with self.assertRaises(runtime.Refusal):
                    self.ready()
                self.assertEqual(self.host.calls, [])
                setattr(self.host, field, True)

    def test_wrong_engine_context_or_original_image_fail_closed(self):
        for field, value in (("engine_id", "replacement-engine"), ("endpoint", "unix:///other.sock"),
                             ("image_open_ok", False)):
            with self.subTest(field=field):
                self.host = EngineHost(self.config)
                setattr(self.host, field, value)
                with self.assertRaisesRegex(runtime.Refusal, "mismatch"):
                    self.ready()
                self.assertEqual(self.clock.now, 0)

    def test_job_boundary_checks_without_starting_or_supervising_engine(self):
        self.ready(start=False)
        self.assertNotIn([self.config["orb"], "start"], self.host.calls)
        self.host.engine_id = "wrong"
        with self.assertRaises(runtime.Refusal):
            self.ready(start=False)
        self.assertEqual(self.clock.now, 0)

    def test_image_identity_and_storage_validation_preserve_original_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = root / "image"
            image.write_bytes(b"original data" * 4)
            value = dict(self.config, image=str(image), image_inode=image.stat().st_ino,
                         image_min_bytes=16, uid=os.getuid(), volume=str(root))
            host = runtime.Host()
            # Native diskutil plist supplies MountPoint, not a Mounted boolean.
            volume = {"VolumeUUID": "original-volume", "FilesystemType": "apfs",
                      "Internal": True, "MountPoint": str(root)}
            with patch.object(host, "run", return_value=plistlib.dumps(volume)):
                host.image(value)
                for overrides in ({"image_inode": value["image_inode"] + 1}, {"uid": os.getuid() + 1},
                                  {"image_min_bytes": 1000}, {"volume_uuid": "wrong"}):
                    with self.assertRaises(runtime.Refusal):
                        host.image(dict(value, **overrides))
                link = root / "link"
                link.symlink_to(image)
                with self.assertRaises(runtime.Refusal):
                    host.image(dict(value, image=str(link)))
            for changed in ({"MountPoint": ""}, {"MountPoint": "/foreign"},
                            {"Internal": False}, {"FilesystemType": "hfs"}):
                with patch.object(host, "run", return_value=plistlib.dumps(dict(volume, **changed))):
                    with self.assertRaises(runtime.Refusal):
                        host.image(value)
            self.assertEqual(image.read_bytes(), b"original data" * 4)

    def test_account_mismatch_never_uses_desktop_or_root_identity(self):
        account = type("Account", (), {"pw_uid": 502, "pw_dir": "/Users/ci-runner"})()
        with patch.object(runtime.pwd, "getpwnam", return_value=account), \
                patch.object(runtime.os, "getuid", return_value=0), \
                patch.dict(os.environ, {"HOME": "/Users/ci-runner"}):
            with self.assertRaisesRegex(runtime.Refusal, "account/HOME"):
                runtime.Host().account(self.config)

    def test_image_open_and_socket_must_belong_to_worker(self):
        host = runtime.Host()
        for output, expected in ((b"p42\ncOrbStack\nu502\n", True),
                                 (b"p42\ncOrbStack\nu0\n", False),
                                 (b"p42\ncBackup\nu502\n", False)):
            with patch.object(host, "run", return_value=output):
                if expected:
                    host.image_open(self.config)
                else:
                    with self.assertRaises(runtime.Refusal):
                        host.image_open(self.config)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "docker.sock"
            value = dict(self.config, socket=str(path), uid=os.getuid())
            with socket.socket(socket.AF_UNIX) as handle:
                handle.bind(str(path))
                host.socket(value)
                with self.assertRaises(runtime.Refusal):
                    host.socket(dict(value, uid=os.getuid() + 1))

    def test_config_schema_and_private_bindings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            with patch.object(runtime, "protected"):
                path.write_text(json.dumps(self.config))
                self.assertEqual(runtime.load_config(path), self.config)
                for change in ({"extra": True}, {"user": "desktop"}, {"image": "/other/image"},
                               {"socket": "/other/docker.sock"}, {"runner_store": "/tmp/runner"}):
                    path.write_text(json.dumps(dict(self.config, **change)))
                    with self.assertRaises(runtime.Refusal):
                        runtime.load_config(path)


class FixtureOperations(install.Operations):
    def __init__(self, runner):
        self.runner = runner
        self.workers = False
        self.unknown = False
        self.fail_pin = False
        self.calls = []

    def command(self, args):
        self.calls.append(args)
        if args[0] == "/bin/ps":
            return (f"{os.getuid()} 42 1 /bin/sh\n" +
                    (f"{os.getuid()} 43 42 /runner/Runner.Worker\n" if self.workers else "")).encode()
        if args[:2] == ["/bin/launchctl", "print"]:
            return ("program = /unknown\nuid = 999\n" if self.unknown else
                    f"program = {self.runner}\nuid = {os.getuid()}\n").encode()
        if self.fail_pin:
            raise runtime.Refusal("pin failed")
        # Model only the external GC-root operation; installer file mutations
        # and receipt recovery execute normally against real temporary files.
        link = Path(args[args.index("--add-root") + 1])
        link.symlink_to(args[-1])
        return b""


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "ArenaCI"
        self.profile = self.base / "profile"
        assets = self.profile / "share/arena-ci"
        assets.mkdir(parents=True)
        for name in ("bootstrap.sh", "job-start.sh"):
            (assets / name).write_bytes(b"#!/bin/sh\nexit 0\n")
        runner_store = self.base / "runner-store"
        runner_store.mkdir()
        runner = runner_store / "runner"
        runner.write_bytes(b"#!/bin/sh\nexit 0\n")
        runner.chmod(0o755)
        runner_root = self.base / "registration"
        runner_root.mkdir()
        self.value = dict(config(), uid=os.getuid(), runner=str(runner), runner_store=str(runner_store),
                          runner_root=str(runner_root), work_folder=str(self.base / "work"))
        (runner_root / ".runner").write_text(json.dumps({"workFolder": self.value["work_folder"], "agentId": 125000}))
        # Credential sentinel is never inspected or mutated by implementation.
        (runner_root / ".credentials").write_bytes(b"credential sentinel")
        self.registration = {p.name: p.read_bytes() for p in runner_root.iterdir()}
        env = {"HOME": self.value["home"], "USER": "ci-runner", "LOGNAME": "ci-runner", "PATH": "/original/path",
               "RUNNER_ROOT": str(runner_root), "ARENA_RUNNER_LEASE_PATH": self.value["lease_path"],
               "NX_CACHE_DIRECTORY": "/original/cache"}
        self.original_value = {"Label": runtime.LABEL, "UserName": "ci-runner", "GroupName": "staff",
                               "ProgramArguments": [str(runner)], "EnvironmentVariables": env,
                               "RunAtLoad": True, "KeepAlive": True, "ExitTimeOut": 60}
        self.original = plistlib.dumps(self.original_value)
        self.value["expected_daemon_sha256"] = install.digest(self.original)
        self.daemon = self.base / "daemon.plist"
        self.daemon.write_bytes(self.original)
        self.daemon.chmod(0o644)
        self.config_path = self.base / "private.json"
        self.config_path.write_text(json.dumps(self.value))
        self.config_path.chmod(0o600)
        self.ops = FixtureOperations(str(runner))
        # UID and path bindings are machine-specific adapters. Exercise the
        # real permission/type checks using the current sandbox account.
        protected = runtime.protected
        self.addCleanup(patch.stopall)
        patch.object(runtime, "protected", side_effect=lambda path, uid=0, private=False:
                     protected(path, uid=os.getuid(), private=private)).start()
        patch.object(runtime, "load_config", return_value=self.value).start()
        self.installation = install.Installation(self.profile, self.config_path, self.root, self.daemon,
                                                self.ops, validate_parents=lambda path: None)

    def test_preview_has_no_writes_apply_preserves_registration_and_environment_rollback_exact(self):
        before = set(self.base.iterdir())
        self.installation.plan()
        self.assertEqual(set(self.base.iterdir()), before)
        receipt = self.installation.apply()
        self.assertEqual(receipt["phase"], "installed")
        updated = plistlib.loads(self.daemon.read_bytes())
        self.assertEqual(updated["ProgramArguments"], ["/bin/sh", str(self.root / "bootstrap.sh")])
        self.assertEqual(updated["UserName"], "ci-runner")
        self.assertEqual(updated["ExitTimeOut"], 60)
        env = updated["EnvironmentVariables"]
        self.assertEqual({k: env[k] for k in self.original_value["EnvironmentVariables"]},
                         self.original_value["EnvironmentVariables"])
        self.assertEqual(env["ACTIONS_RUNNER_HOOK_JOB_STARTED"], str(self.root / "job-start.sh"))
        for name, data in self.registration.items():
            self.assertEqual((Path(self.value["runner_root"]) / name).read_bytes(), data)
        self.assertTrue((self.root / "package-closure").is_symlink())
        self.assertTrue((self.root / "runner-closure").is_symlink())
        self.assertTrue(all("--indirect" in call for call in self.ops.calls if "--add-root" in call))
        self.installation.rollback()
        self.assertEqual(self.daemon.read_bytes(), self.original)
        self.assertEqual((self.root / "backups/original.plist").read_bytes(), self.original)
        self.assertTrue((self.root / "package-closure").is_symlink())
        self.assertFalse(any(call[:2] in (["/bin/launchctl", "bootout"], ["/bin/launchctl", "bootstrap"])
                             for call in self.ops.calls))

    def test_active_worker_unknown_service_or_changed_daemon_refused(self):
        for field in ("workers", "unknown"):
            with self.subTest(field=field):
                setattr(self.ops, field, True)
                with self.assertRaises(runtime.Refusal):
                    self.installation.apply()
                self.assertFalse(self.root.exists())
                self.assertEqual(self.daemon.read_bytes(), self.original)
                setattr(self.ops, field, False)
        self.daemon.write_bytes(b"unknown daemon")
        with self.assertRaisesRegex(runtime.Refusal, "unknown ownership"):
            self.installation.apply()

    def test_interrupted_pin_is_recoverable_without_daemon_change(self):
        self.ops.fail_pin = True
        with self.assertRaisesRegex(runtime.Refusal, "pin failed"):
            self.installation.apply()
        self.assertEqual(self.daemon.read_bytes(), self.original)
        self.assertEqual(json.loads((self.root / "receipt.json").read_bytes())["phase"], "prepared")
        self.installation.rollback()
        self.assertEqual(self.daemon.read_bytes(), self.original)

    def test_rollback_refuses_active_worker_or_foreign_changes(self):
        self.installation.apply()
        self.ops.workers = True
        with self.assertRaisesRegex(runtime.Refusal, "active Runner.Worker"):
            self.installation.rollback()
        self.ops.workers = False
        (self.root / "bootstrap.sh").write_bytes(b"foreign change")
        with self.assertRaisesRegex(runtime.Refusal, "managed file changed"):
            self.installation.rollback()

    def test_symlink_and_writable_daemon_refused(self):
        self.daemon.chmod(0o666)
        with self.assertRaisesRegex(runtime.Refusal, "unsafe permissions"):
            self.installation.plan()
        self.daemon.unlink()
        self.daemon.symlink_to(self.config_path)
        with self.assertRaisesRegex(runtime.Refusal, "regular-file"):
            self.installation.plan()


class BootstrapTests(unittest.TestCase):
    def test_os_shell_waits_for_late_interpreter_then_preserves_environment(self):
        template_path = Path(os.environ.get("ARENA_CI_BOOTSTRAP_TEMPLATE", ASSETS / "arena-ci-bootstrap.sh"))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            interpreter = root / "late-python"
            payload = root / "runtime"
            payload.write_bytes(b"runtime fixture")
            bootstrap = template_path.read_text().replace("@python@", str(interpreter)).replace("@runtime@", str(payload)).replace("@mode@", "check")
            script = root / "bootstrap.sh"
            script.write_text(bootstrap)
            with subprocess.Popen(["/bin/sh", str(script)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  env=dict(os.environ, PATH="/original/runner/path")) as process:
                try:
                    # Wait for observable missing-dependency admission before
                    # publishing the interpreter; no wall-clock arrival race.
                    with selectors.DefaultSelector() as selector:
                        selector.register(process.stderr, selectors.EVENT_READ)
                        self.assertTrue(selector.select(timeout=4), "bootstrap did not report waiting")
                    self.assertIn(b"waiting up to 180s", process.stderr.readline())
                    staged = root / "staged-python"
                    staged.write_text('#!/bin/sh\nif [ "$2" = "-c" ]; then exit 0; fi\nprintf "%s\\n" "$PATH" "$5"\n')
                    staged.chmod(0o755)
                    staged.replace(interpreter)
                    stdout, stderr = process.communicate(timeout=8)
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertEqual(stdout.splitlines(), [b"/original/runner/path", b"check"])
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()


if __name__ == "__main__":
    unittest.main()
