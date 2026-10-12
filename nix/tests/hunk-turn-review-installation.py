"""Exercise the public feature installer in an isolated home and launchd adapter."""

import json
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import select
import signal
import socketserver
import sys
import tempfile
import time
import threading
import unittest

INSTALLER = Path(
    os.environ.get(
        "HUNK_REVIEW_TEST_INSTALLER",
        Path(__file__).resolve().parents[1] / "runtime/hunk-turn-review-install.py",
    )
)


class Installation(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="hunk-install-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir()
        self.profile = Path(
            os.environ.get("HUNK_REVIEW_TEST_PROFILE", self.root / "package")
        )
        if "HUNK_REVIEW_TEST_PROFILE" not in os.environ:
            self.profile.mkdir()
            for asset in ("core", "pi", "codex", "plugin", "ui"):
                (self.profile / asset).mkdir()
            (self.profile / "bin").mkdir()
            (self.profile / "bin/codex").write_text("#!/bin/sh\nexit 0\n")
            (self.profile / "bin/codex").chmod(0o755)
            (self.profile / "share").mkdir()
            manifest = {
                "links": {
                    ".local/share/hunk-turn-review": "core",
                    ".pi/agent/extensions/hunk-turn-review": "pi",
                    ".codex/hunk-turn-review": "codex",
                    ".config/hunk-turn-review/herdr-plugin": "plugin",
                },
                "plugin": "plugin",
                "hooks": {
                    "hooks": {
                        "UserPromptSubmit": [
                            {
                                "hooks": [
                                    {
                                        "type": "command",
                                        "command": "/nix/store/example/bin/hunk-turn-review-hook prompt",
                                    }
                                ]
                            }
                        ]
                    }
                },
                "missing": [],
                "herdr": {"minVersion": "0.9.3", "protocol": 22},
                "runtime": "/nix/store/example/bin/hunk-turn-review-runtime",
                "client": str(self.profile / "core/client.mjs"),
            }
            (self.profile / "share/hunk-turn-review-install.json").write_text(
                json.dumps(manifest)
            )
        self.adapter = self.root / "launchctl"
        fake = self.root / "fixture-runtime.py"
        fake.write_text(
            'import socket,os,json\nfrom pathlib import Path\np=Path(os.environ["HUNK_TURN_REVIEW_SOCKET"]);p.unlink(missing_ok=True)\ns=socket.socket(socket.AF_UNIX);s.bind(str(p));os.chmod(p,0o600);s.listen()\nwhile True:\n c,_=s.accept();c.recv(4096);c.sendall(b\'{"version":1,"id":"installation-health","error":{"code":"REFUSED"}}\\n\');c.close()\n'
        )
        self.adapter.write_text(
            "#!"
            + sys.executable
            + '\nimport os,sys,json,signal,subprocess,plistlib\nfrom pathlib import Path\nh=Path(os.environ["HOME"]);p=h/"service.json"\na=sys.argv[1]\nif a=="print":\n if not p.exists():sys.exit(1)\n r=json.loads(p.read_text());os.kill(r["pid"],0);print("program = "+r["program"])\nelif a=="bootout":\n if p.exists():\n  r=json.loads(p.read_text());os.kill(r["pid"],signal.SIGTERM);p.unlink()\nelif a=="bootstrap":\n v=plistlib.loads(Path(sys.argv[3]).read_bytes());e={**os.environ,**v["EnvironmentVariables"]};args=v["ProgramArguments"]\n if args[0].startswith("/nix/store/example/"):args=['
            + repr(sys.executable)
            + ","
            + repr(str(fake))
            + ']\n with open(v["StandardErrorPath"],"ab") as log:c=subprocess.Popen(args,env=e,stdout=log,stderr=log,start_new_session=True,umask=v["Umask"])\n p.write_text(json.dumps({"pid":c.pid,"program":v["ProgramArguments"][0]}))\n'
        )
        self.adapter.chmod(0o755)

        def stop_service():
            pid_path = self.home / "service.json"
            if pid_path.exists():
                try:
                    os.kill(json.loads(pid_path.read_text())["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass

        self.addCleanup(stop_service)
        self.herdr = self.root / "herdr"
        self.herdr.write_text(
            "#!"
            + sys.executable
            + '\nimport json, os\nfrom pathlib import Path\np = Path(os.environ["XDG_CONFIG_HOME"]) / "herdr/plugins.json"\nr = json.loads(p.read_text())\nr.append({"plugin_id":"hunk-turn-review","enabled":True})\np.write_text(json.dumps(r))\n'
        )
        self.herdr.chmod(0o755)
        if "HUNK_REVIEW_TEST_HERDR" in os.environ:
            self.herdr = Path(os.environ["HUNK_REVIEW_TEST_HERDR"])
        self.home.joinpath(".codex").mkdir()
        self.hooks = self.home / ".codex/hooks.json"
        self.original = b'{"hooks":{"SessionStart":[{"hooks":[{"command":"tasks-axi","type":"command"}]}]},"custom":{"keep":true}}\n'
        self.hooks.write_bytes(self.original)
        (self.home / ".codex/config.toml").write_text(
            '[features]\nhooks = true\n[hooks.state."existing"]\ntrusted = true\n'
        )
        self.config = (self.home / ".codex/config.toml").read_bytes()
        self.target_version = "0.9.3"
        self.target_protocol = 22
        self.target_layout = True
        fixture = self

        class Target(socketserver.StreamRequestHandler):
            def handle(self):
                request = json.loads(self.rfile.readline())
                method = request["method"]
                result = {"id": request["id"]}
                if method == "session.snapshot":
                    result["result"] = {
                        "snapshot": {
                            "version": fixture.target_version,
                            "protocol": fixture.target_protocol,
                            "panes": [],
                            "agents": [],
                            "layouts": [],
                        }
                    }
                elif method == "plugin.list":
                    result["result"] = {"plugins": []}
                else:
                    result["error"] = {
                        "code": "pane_not_found"
                        if fixture.target_layout
                        else "invalid_request"
                    }
                self.wfile.write((json.dumps(result) + "\n").encode())

        self.target_socket = self.root / "herdr.sock"
        target = socketserver.UnixStreamServer(str(self.target_socket), Target)
        self.target_socket.chmod(0o600)
        thread = threading.Thread(target=target.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(target.server_close)
        self.addCleanup(target.shutdown)

    def run_cli(self, action, environment=None, extra=()):
        return subprocess.run(
            [
                sys.executable,
                INSTALLER,
                action,
                "--home",
                self.home,
                "--profile",
                self.profile,
                "--launchctl",
                self.adapter,
                "--herdr",
                self.herdr,
                "--herdr-socket",
                self.target_socket,
                "--nix-store",
                os.environ.get("HUNK_REVIEW_TEST_NIX_STORE", "/usr/bin/true"),
                *extra,
            ],
            text=True,
            capture_output=True,
            env={**os.environ, "HOME": str(self.home), **(environment or {})},
        )

    def filesystem_fault(self, source):
        directory = self.root / "faults"
        directory.mkdir(exist_ok=True)
        (directory / "sitecustomize.py").write_text(source)
        return {"PYTHONPATH": str(directory)}

    @contextmanager
    def native_server(self, binary, session):
        xdg = self.home / ".config"
        (xdg / "herdr").mkdir(parents=True, mode=0o700, exist_ok=True)
        config = xdg / "herdr/config.toml"
        config.write_text('onboarding = false\n[shell]\ncommand = "/bin/zsh"\n')
        environment = {
            k: v for k, v in os.environ.items() if not k.startswith("HERDR_")
        }
        environment.update(
            HOME=str(self.home),
            XDG_CONFIG_HOME=str(xdg),
            HERDR_CONFIG_PATH=str(config),
            HERDR_SESSION=session,
        )
        server = subprocess.Popen(
            [binary, "--session", session, "server"],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )

        def cli(*argv):
            return subprocess.run(
                [binary, *argv, "--session", session],
                env=environment,
                capture_output=True,
                text=True,
            )

        try:
            deadline = time.monotonic() + 10
            while True:
                snapshot = cli("api", "snapshot")
                if snapshot.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    self.fail(snapshot.stderr)
                time.sleep(0.05)
            yield cli, xdg / "herdr/sessions" / session / "herdr.sock"
        finally:
            cli("session", "stop", session, "--json")
            server.terminate()
            server.communicate(timeout=10)

    def postrename_fault(self, crash=False, persistent=False):
        return self.filesystem_fault(
            "import os, stat\nfrom pathlib import Path\n"
            "original = os.fsync\nfired = False\n"
            "def fsync(fd):\n global fired\n"
            f" p = Path({str(self.hooks)!r})\n"
            " s = os.fstat(fd)\n"
            " if stat.S_ISDIR(s.st_mode) and s.st_ino == p.parent.stat().st_ino and "
            + ("True" if persistent else "not fired")
            + " and p.exists() and b'UserPromptSubmit' in p.read_bytes():\n"
            "  fired = True\n"
            + (
                "  os._exit(73)\n"
                if crash
                else "  raise OSError('injected directory fsync failure')\n"
            )
            + " return original(fd)\nos.fsync = fsync\n"
        )

    def test_postrename_fsync_failure_restores_every_configuration_path(self):
        result = self.run_cli("activate", self.postrename_fault())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / ".local/state/hunk-turn-review/profile").exists())
        self.assertEqual(self.run_cli("activate").returncode, 0)

    def test_public_reactivation_recovers_interrupted_durable_journal(self):
        result = self.run_cli("activate", self.postrename_fault(crash=True))
        self.assertEqual(result.returncode, 73)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_cli("rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)

    def test_failed_restoration_retains_receipt_until_public_rollback_verifies_it(self):
        fault = self.filesystem_fault(
            "import os,stat\nfrom pathlib import Path\noriginal=os.fsync\n"
            "def fsync(fd):\n s=os.fstat(fd)\n"
            f" if stat.S_ISDIR(s.st_mode) and s.st_ino == Path({str(self.hooks.parent)!r}).stat().st_ino:\n"
            "  raise OSError('injected restoration durability failure')\n"
            " return original(fd)\nos.fsync=fsync\n"
        )
        result = self.run_cli("activate", fault)
        self.assertNotEqual(result.returncode, 0)
        receipt = self.home / ".local/state/hunk-turn-review/installation.json"
        self.assertTrue(receipt.exists())
        self.assertEqual(self.hooks.read_bytes(), self.original)
        result = self.run_cli("rollback", fault)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(receipt.exists())
        result = self.run_cli("rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(receipt.exists())

    def test_reactivation_preserves_user_edit_after_interrupted_transaction(self):
        result = self.run_cli("activate", self.postrename_fault(crash=True))
        self.assertEqual(result.returncode, 73)
        self.hooks.write_text('{"user":"edited after crash"}\n')
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collision", result.stderr.lower())
        self.assertEqual(self.hooks.read_text(), '{"user":"edited after crash"}\n')
        self.assertTrue(
            (self.home / ".local/state/hunk-turn-review/installation.json").exists()
        )

    def test_recovery_refuses_receipt_that_disagrees_with_durable_backup(self):
        result = self.run_cli("activate", self.postrename_fault(crash=True))
        self.assertEqual(result.returncode, 73)
        path = self.home / ".local/state/hunk-turn-review/installation.json"
        receipt = json.loads(path.read_text())
        receipt["changes"] = []
        path.write_text(json.dumps(receipt))
        installed = self.hooks.read_bytes()
        result = self.run_cli("rollback")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.hooks.read_bytes(), installed)
        self.assertTrue(path.exists())

    def test_rollback_refuses_redirected_parent_with_identical_registry(self):
        owner = self.root / "original-checkout"
        owner.mkdir()
        registry = owner / "plugins.json"
        registry.write_text("[]\n")
        config = self.home / ".config"
        config.mkdir()
        parent = config / "herdr"
        parent.symlink_to(owner)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        replacement = self.root / "new-owner"
        replacement.mkdir()
        other = replacement / "plugins.json"
        other.write_bytes(registry.read_bytes())
        other.chmod(registry.stat().st_mode & 0o777)
        installed = other.read_bytes()
        parent.unlink()
        parent.symlink_to(replacement)
        result = self.run_cli("rollback")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("parent", result.stderr.lower())
        self.assertEqual(other.read_bytes(), installed)
        self.assertTrue((self.home / "service.json").exists())
        parent.unlink()
        parent.symlink_to(owner)
        self.assertEqual(self.run_cli("rollback").returncode, 0)
        self.assertEqual(registry.read_text(), "[]\n")

    def test_activation_preserves_private_shell_modes_and_symlink_target(self):
        shell = self.home / ".zshenv"
        shell.write_text("export PRIVATE=retained\n")
        shell.chmod(0o600)
        target = self.root / "managed-private-zshrc"
        target.write_text("export TARGET=retained\n")
        target.chmod(0o600)
        linked = self.home / ".zshrc"
        linked.symlink_to(target)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(shell.stat().st_mode & 0o777, 0o600)
        self.assertEqual(linked.stat().st_mode & 0o777, 0o600)
        self.assertEqual(target.read_text(), "export TARGET=retained\n")
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.run_cli("rollback").returncode, 0)
        self.assertTrue(linked.is_symlink())

    def test_edit_between_hook_read_and_snapshot_is_preserved(self):
        fault = self.filesystem_fault(
            "from pathlib import Path\ntext = Path.read_text\nbytes_ = Path.read_bytes\nfired = False\n"
            "def read(path, original, *args, **kwargs):\n global fired\n"
            " result = original(path, *args, **kwargs)\n"
            f" if str(path) == {str(self.hooks)!r} and not fired:\n"
            '  fired = True\n  path.write_text(\'{"concurrent":true,"hooks":{}}\\n\')\n'
            " return result\nPath.read_text = lambda p,*a,**k: read(p,text,*a,**k)\n"
            "Path.read_bytes = lambda p,*a,**k: read(p,bytes_,*a,**k)\n"
        )
        result = self.run_cli("activate", fault)
        # A single capture may either include the edit or refuse it; it cannot
        # discard an edit that happened after the original contents were read.
        self.assertTrue(
            json.loads(self.hooks.read_text()).get("concurrent"), result.stderr
        )

    def test_edit_while_preparing_atomic_replacement_is_not_overwritten(self):
        fault = self.filesystem_fault(
            "import os,stat\nfrom pathlib import Path\noriginal=os.fsync\n"
            "def fsync(fd):\n"
            " s=os.fstat(fd)\n"
            f" for p in Path({str(self.hooks.parent)!r}).glob('.hunk-turn-review-*'):\n"
            "  if stat.S_ISREG(s.st_mode) and p.stat().st_ino == s.st_ino and b'UserPromptSubmit' in p.read_bytes():\n"
            f"   Path({str(self.root / 'fault-fired')!r}).touch()\n"
            f'   Path({str(self.hooks)!r}).write_text(\'{{"concurrent":true,"hooks":{{}}}}\\n\')\n'
            " return original(fd)\nos.fsync=fsync\n"
        )
        result = self.run_cli("activate", fault)
        self.assertTrue((self.root / "fault-fired").exists())
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(
            json.loads(self.hooks.read_text()).get("concurrent"), result.stderr
        )
        self.assertTrue(
            (self.home / ".local/state/hunk-turn-review/installation.json").exists()
        )

    def test_rollback_refuses_changed_materialized_symlink_target_before_stopping(self):
        target = self.root / "managed-shell"
        target.write_text("export ORIGINAL=1\n")
        shell = self.home / ".zshenv"
        shell.symlink_to(target)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        installed = shell.read_bytes()
        target.write_text("export CONCURRENT=1\n")
        result = self.run_cli("rollback")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(shell.is_symlink())
        self.assertEqual(shell.read_bytes(), installed)
        self.assertTrue((self.home / "service.json").exists())

    def log_collision(self, kind):
        state = self.home / ".local/state/hunk-turn-review"
        state.mkdir(parents=True, mode=0o700, exist_ok=True)
        unrelated = self.root / (kind + "-unrelated.log")
        unrelated.write_text("unrelated data\n")
        log = state / "runtime-error.log"
        if kind == "symlink":
            log.symlink_to(unrelated)
        elif kind == "hardlink":
            os.link(unrelated, log)
        else:
            log.write_text("previous owner\n")
            log.chmod(0o600)
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("log", result.stderr.lower())
        self.assertEqual(unrelated.read_text(), "unrelated data\n")
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / "service.json").exists())

    def test_logs_refuse_unverified_private_files(self):
        self.log_collision("file")

    def test_logs_refuse_foreign_symlinks(self):
        self.log_collision("symlink")

    def test_logs_refuse_hardlinks(self):
        self.log_collision("hardlink")

    def test_owned_logs_retain_data_through_rollback_and_reactivation(self):
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        log = self.home / ".local/state/hunk-turn-review/runtime.log"
        self.assertTrue(log.is_file())
        self.assertEqual(log.stat().st_mode & 0o777, 0o600)
        log.write_text("retained feature output\n")
        self.assertEqual(self.run_cli("rollback").returncode, 0)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(log.read_text(), "retained feature output\n")

    def test_incompatible_target_server_blocks_before_configuration_or_launchd(self):
        self.target_version = "0.9.1"
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Herdr incompatible", result.stderr)
        self.assertIn("0.9.1", result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / "service.json").exists())

    def test_target_without_layout_capability_blocks_even_with_current_version(self):
        self.target_layout = False
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Herdr incompatible", result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)

    def test_wrong_target_protocol_blocks_before_runtime_health(self):
        self.target_protocol = 21
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Herdr incompatible", result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / "service.json").exists())

    def test_installed_profile_reactivation_refuses_replaced_owned_log(self):
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.home / ".local/state/hunk-turn-review"
        log = state / "runtime.log"
        original = state / "retained-runtime.log"
        log.rename(original)
        log.symlink_to(original)
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("log", result.stderr.lower())
        self.assertTrue(original.exists())
        self.assertTrue((self.home / "service.json").exists())

    def test_status_separates_installation_health_and_workflow_acceptance(self):
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_cli("status")
        status = json.loads(result.stdout)
        self.assertEqual(status["installation"], "installed")
        self.assertEqual(status["herdr"]["version"], "0.9.3")
        self.assertEqual(status["runtimeHealth"], "healthy-at-installation")
        self.assertEqual(status["workflowAcceptance"], "pending native acceptance")

    @unittest.skipUnless(
        os.environ.get("HUNK_REVIEW_TEST_HERDR_OLD")
        and os.environ.get("HUNK_REVIEW_TEST_PROFILE"),
        "Requires retained native Herdr 0.9.1 and built profile",
    )
    def test_native_091_rejects_built_plugin_without_touching_original_server(self):
        binary = os.environ["HUNK_REVIEW_TEST_HERDR_OLD"]
        xdg = self.root / "xdg"
        (xdg / "herdr").mkdir(parents=True, mode=0o700)
        config = xdg / "herdr/config.toml"
        config.write_text('onboarding = false\n[shell]\ncommand = "/bin/zsh"\n')
        session = "htr-old"
        environment = {
            k: v for k, v in os.environ.items() if not k.startswith("HERDR_")
        }
        environment.update(
            HOME=str(self.home),
            XDG_CONFIG_HOME=str(xdg),
            HERDR_CONFIG_PATH=str(config),
            HERDR_SESSION=session,
        )
        server = subprocess.Popen(
            [binary, "--session", session, "server"],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            deadline = time.monotonic() + 10
            while True:
                snapshot = subprocess.run(
                    [binary, "api", "snapshot", "--session", session],
                    env=environment,
                    capture_output=True,
                    text=True,
                )
                if snapshot.returncode == 0:
                    break
                if time.monotonic() >= deadline:
                    self.fail(snapshot.stderr)
                time.sleep(0.05)
            self.assertEqual(
                json.loads(snapshot.stdout)["result"]["snapshot"]["version"], "0.9.1"
            )
            manifest = json.loads(
                (self.profile / "share/hunk-turn-review-install.json").read_text()
            )
            linked = subprocess.run(
                [
                    binary,
                    "plugin",
                    "link",
                    str(self.profile / manifest["plugin"]),
                    "--session",
                    session,
                ],
                env=environment,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(linked.returncode, 0, linked.stdout)
            self.assertIn("0.9.3", linked.stdout + linked.stderr)
            print(
                "Native Herdr 0.9.1 rejection:", (linked.stdout + linked.stderr).strip()
            )
        finally:
            subprocess.run(
                [binary, "session", "stop", session, "--json"],
                env=environment,
                capture_output=True,
            )
            server.terminate()
            server.communicate(timeout=10)

    @unittest.skipUnless(
        os.environ.get("HUNK_REVIEW_TEST_HERDR")
        and os.environ.get("HUNK_REVIEW_TEST_PROFILE"),
        "Requires current native Herdr and built profile",
    )
    def test_native_server_installation_and_argv_layout_registry_conformance(self):
        import socket

        with self.native_server(str(self.herdr), "htr-new") as (cli, target):
            self.target_socket = target

            def rpc(method, params):
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(3)
                    connection.connect(str(target))
                    connection.sendall(
                        (
                            json.dumps(
                                {
                                    "id": "conformance",
                                    "method": method,
                                    "params": params,
                                }
                            )
                            + "\n"
                        ).encode()
                    )
                    data = b""
                    while b"\n" not in data:
                        data += connection.recv(65536)
                response = json.loads(data.split(b"\n", 1)[0])
                self.assertNotIn("error", response, response)
                return response["result"]

            fixture = self.root / "argv-plugin"
            fixture.mkdir()
            marker = self.root / "argv.json"
            script = fixture / "argv.py"
            script.write_text(
                "import json,os,sys,time\nfrom pathlib import Path\n"
                + f"Path({str(marker)!r}).write_text(json.dumps({{'argv':sys.argv[1:],'cwd':os.getcwd(),'env':os.environ.get('HTR_CONFORMANCE')}}))\ntime.sleep(60)\n"
            )
            (fixture / "herdr-plugin.toml").write_text(
                'id="htr.argv"\nname="Owned argv fixture"\nversion="1.0.0"\nmin_herdr_version="0.9.3"\nplatforms=["macos"]\n[[panes]]\nid="review"\ntitle="Fixture"\ncommand='
                + json.dumps([sys.executable, str(script), "argument with spaces"])
                + '\nplacement="split"\n'
            )
            linked = cli("plugin", "link", str(fixture))
            self.assertEqual(linked.returncode, 0, linked.stderr)
            result = self.run_cli("activate")
            self.assertEqual(result.returncode, 0, result.stderr)
            registry = json.loads(cli("plugin", "list", "--json").stdout)["result"][
                "plugins"
            ]
            entry = next(p for p in registry if p["plugin_id"] == "hunk-turn-review")
            self.assertTrue(entry["enabled"])
            self.assertIsInstance(entry["panes"][0]["command"], list)
            created = json.loads(
                cli(
                    "workspace",
                    "create",
                    "--cwd",
                    str(self.home),
                    "--label",
                    "owned-fixture",
                    "--no-focus",
                ).stdout
            )["result"]
            pane = created["root_pane"]["pane_id"]
            focused = rpc("session.snapshot", {})["snapshot"]["focused_pane_id"]
            opened = rpc(
                "plugin.pane.open",
                {
                    "plugin_id": "htr.argv",
                    "entrypoint": "review",
                    "target_pane_id": pane,
                    "placement": "split",
                    "direction": "right",
                    "focus": False,
                    "cwd": str(self.home),
                    "env": {"HTR_CONFORMANCE": "retained argv"},
                },
            )["plugin_pane"]["pane"]
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertEqual(
                json.loads(marker.read_text()),
                {
                    "argv": ["argument with spaces"],
                    "cwd": str(self.home),
                    "env": "retained argv",
                },
            )
            self.assertEqual(
                rpc("session.snapshot", {})["snapshot"]["focused_pane_id"], focused
            )
            layout = rpc("pane.layout", {"pane_id": pane})["layout"]
            positions = {p["pane_id"]: p["rect"] for p in layout["panes"]}
            self.assertGreater(positions[opened["pane_id"]]["x"], positions[pane]["x"])
            rpc(
                "pane.report_metadata",
                {
                    "pane_id": opened["pane_id"],
                    "source": "hunk-turn-review",
                    "tokens": {"htr_actor": "owned-conformance"},
                },
            )
            snapshot = rpc("session.snapshot", {})["snapshot"]
            self.assertEqual(
                next(p for p in snapshot["panes"] if p["pane_id"] == opened["pane_id"])[
                    "tokens"
                ]["htr_actor"],
                "owned-conformance",
            )
            rpc("plugin.pane.close", {"pane_id": opened["pane_id"]})
            tab = rpc(
                "plugin.pane.open",
                {
                    "plugin_id": "htr.argv",
                    "entrypoint": "review",
                    "placement": "tab",
                    "workspace_id": created["workspace"]["workspace_id"],
                    "focus": False,
                    "cwd": str(self.home),
                },
            )["plugin_pane"]["pane"]
            rpc("plugin.pane.close", {"pane_id": tab["pane_id"]})
            result = self.run_cli("rollback")
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_activation_preserves_existing_hooks_and_native_trust(self):
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        hooks = json.loads(self.hooks.read_text())
        self.assertEqual(
            hooks["hooks"]["SessionStart"][0]["hooks"][0]["command"], "tasks-axi"
        )
        self.assertTrue(hooks["custom"]["keep"])
        self.assertIn("UserPromptSubmit", hooks["hooks"])
        self.assertEqual((self.home / ".codex/config.toml").read_bytes(), self.config)
        self.assertIn("native", result.stdout)

    def test_rollback_restores_symlink_and_hooks_but_retains_durable_reviews(self):
        original = self.root / "managed-zshenv"
        original.write_text("export EXISTING=retained\n")
        shell = self.home / ".zshenv"
        shell.symlink_to(original)
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = self.home / ".local/state/hunk-turn-review/data/review.json"
        data.write_text('{"humanNote":"retain"}')
        result = self.run_cli("rollback")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertTrue(shell.is_symlink())
        self.assertEqual(shell.resolve(), original)
        self.assertEqual(data.read_text(), '{"humanNote":"retain"}')

    def test_existing_manual_extension_refuses_before_hook_or_shell_changes(self):
        path = self.home / ".pi/agent/extensions/hunk-turn-review"
        path.mkdir(parents=True)
        (path / "manual.txt").write_text("keep")
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collision", result.stderr)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / ".zshenv").exists())

    def test_launchd_failure_restores_all_configuration(self):
        self.adapter.write_text("#!/bin/sh\nexit 1\n")
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.hooks.read_bytes(), self.original)
        self.assertFalse((self.home / ".zshenv").exists())
        self.assertFalse(
            (self.home / ".pi/agent/extensions/hunk-turn-review").is_symlink()
        )

    def test_launchd_receipt_without_runtime_health_does_not_install(self):
        self.adapter.write_text('#!/bin/sh\n[ "$1" != print ]\n')
        result = self.run_cli("activate")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.hooks.read_bytes(), self.original)

    def test_rollback_refuses_to_overwrite_post_install_user_edits(self):
        self.assertEqual(self.run_cli("activate").returncode, 0)
        self.hooks.write_text('{"human":"new setting"}')
        result = self.run_cli("rollback")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("collision", result.stderr)
        self.assertEqual(self.hooks.read_text(), '{"human":"new setting"}')
        self.assertTrue(
            (self.home / ".local/state/hunk-turn-review/installation.json").is_file()
        )

    def test_fresh_shell_resolves_feature_codex_after_existing_startup(self):
        (self.home / ".zshrc").write_text('export PATH="/opt/homebrew/bin:$PATH"\n')
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        result = subprocess.run(
            [
                os.environ.get("HUNK_REVIEW_TEST_ZSH", "/bin/zsh"),
                "-d",
                "-i",
                "-c",
                "command -v codex",
            ],
            env={**os.environ, "HOME": str(self.home)},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.stdout.strip(),
            str(self.home / ".local/state/hunk-turn-review/profile/bin/codex"),
        )
        if (self.profile / "bin/bash").exists():
            result = subprocess.run(
                [
                    os.environ.get("HUNK_REVIEW_TEST_ZSH", "/bin/zsh"),
                    "-d",
                    "-i",
                    "-c",
                    'command -v bash; bash --noprofile --norc -c \'printf "%s\\n" "$BASH_VERSION"\'',
                ],
                env={**os.environ, "HOME": str(self.home)},
                capture_output=True,
                text=True,
                timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            selected, version = result.stdout.strip().splitlines()
            self.assertEqual(
                selected,
                str(self.home / ".local/state/hunk-turn-review/profile/bin/bash"),
            )
            self.assertTrue(version.startswith("5.3.16("), version)

    @unittest.skipUnless(
        os.environ.get("HUNK_REVIEW_TEST_PI"), "Requires the declared native Pi package"
    )
    def test_native_pi_discovers_global_extension_without_extension_flags(self):
        result = self.run_cli("activate")
        self.assertEqual(result.returncode, 0, result.stderr)
        environment = {**os.environ, "HOME": str(self.home)}
        environment.pop("PI_CODING_AGENT_DIR", None)
        process = subprocess.Popen(
            [os.environ["HUNK_REVIEW_TEST_PI"], "--mode", "rpc", "--no-session"],
            cwd=self.home,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            process.stdin.write(b'{"id":"packaging","type":"get_commands"}\n')
            process.stdin.flush()
            deadline = time.monotonic() + 20
            data = b""
            response = None
            while time.monotonic() < deadline:
                if not select.select([process.stdout], [], [], 0.5)[0]:
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    break
                data += chunk
                while b"\n" in data:
                    line, data = data.split(b"\n", 1)
                    item = json.loads(line)
                    if item.get("id") == "packaging":
                        response = item
                if response is not None:
                    break
            self.assertIsNotNone(response, "Native Pi did not answer command inventory")
            commands = {command["name"] for command in response["data"]["commands"]}
            self.assertTrue(
                {"hunk-review-task", "hunk-review-reopen", "hunk-review-tab"}
                <= commands,
                "Installed feature was not discovered through native global loading",
            )
        finally:
            process.terminate()
            try:
                process.communicate(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()


if __name__ == "__main__":
    unittest.main()
