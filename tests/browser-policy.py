import hashlib
import hmac
import http.server
import importlib.util
import json
import os
import pathlib
import selectors
import signal
import socket
import struct
import shutil
import subprocess
import tempfile
import textwrap
import threading
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "home/.local/bin/chrome-devtools-axi"
POLICY = ROOT / "home/.agents/skills/browser-routing/scripts/browser-policy.mjs"


class BrowserPolicyContractTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.home = pathlib.Path(self.temp_dir.name) / "home"
        self.home.mkdir()
        self.repo = pathlib.Path(self.temp_dir.name) / "repo"
        self.repo.mkdir()
        subprocess.run(["git", "init", "--quiet", str(self.repo)], check=True)
        self.env = os.environ.copy()
        self.env.pop("HERDR_ENV", None)
        self.env["HOME"] = str(self.home)
        for name in tuple(self.env):
            if (
                name.startswith(
                    (
                        "CHROME_DEVTOOLS_AXI_",
                        "CHROME_DEVTOOLS_MCP_",
                        "PUPPETEER_",
                        "PLAYWRIGHT_",
                    )
                )
                or name.lower().startswith("npm_config_")
                or name
                in {
                    "NODE_OPTIONS",
                    "NODE_PATH",
                    "BROWSER",
                    "CHROME_BIN",
                    "CHROMIUM_BIN",
                    "GOOGLE_CHROME_SHIM",
                    "CHROME_PATH",
                    "CHROME_EXECUTABLE",
                    "DEBUG",
                    "NODE_DEBUG",
                }
            ):
                self.env.pop(name)
        if POLICY.exists():
            module = (
                self.home / ".agents/skills/browser-routing/scripts/browser-policy.mjs"
            )
            module.parent.mkdir(parents=True)
            shutil.copytree(POLICY.parent, module.parent, dirs_exist_ok=True)

    def prepare_profile(self, task="attach-check", env=None, targets=()):
        args = ["--repo-qa", task, "prepare-profile"]
        for target in targets:
            args.extend(("--target", target))
        result = self.invoke(*args, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_prepare_profile_is_private_empty_and_launch_free(self):
        allocation = self.prepare_profile()
        receipt = pathlib.Path(allocation["receipt"])
        profile = pathlib.Path(allocation["profile"])
        self.assertEqual(list(profile.iterdir()), [])
        self.assertEqual(json.loads(receipt.read_text())["value"]["origins"], [])
        self.assertEqual(profile.stat().st_mode & 0o777, 0o700)
        self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
        self.assertNotEqual(receipt.parent, profile)
        other = self.prepare_profile()
        self.assertNotEqual(other["profile"], allocation["profile"])
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attach_rejects_bad_receipt_and_mismatched_task_before_inspection(self):
        allocation = self.prepare_profile()
        receipt = pathlib.Path(allocation["receipt"])
        for candidate, task in [(str(receipt), "other"), (str(receipt) + "x", "attach-check")]:
            result = self.invoke("--repo-qa", task, "attach", candidate,
                                 "--pid", "123", "--port", "9222", "snapshot")
            self.assertEqual(result.returncode, 78)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_prepare_neutralizes_only_scoped_inherited_launch_controls(self):
        env = self.env.copy()
        env.update({"CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH": "private-marker",
                    "CHROME_DEVTOOLS_AXI_HEADED": "1", "PLAYWRIGHT_BROWSERS_PATH": "private-marker"})
        allocation = self.prepare_profile(env=env)
        self.assertNotIn("private-marker", json.dumps(allocation))
        env["CHROME_DEVTOOLS_AXI_BROWSER_URL"] = "private-marker"
        result = self.invoke("--repo-qa", "attach-check", "prepare-profile", env=env)
        self.assertEqual(result.returncode, 78)
        self.assertNotIn("private-marker", result.stdout + result.stderr)

    def available_attachment_task(self, preferred=None, reserve=False):
        candidates = ([preferred] if preferred is not None else [])
        candidates.extend(f"multi-origin-{index}" for index in range(1000))
        for task in candidates:
            probe = socket.socket()
            try:
                probe.bind(("127.0.0.1", self.session_port(task)))
            except OSError:
                probe.close()
                continue
            if self.session_state_dir(task).exists():
                probe.close()
                continue
            if reserve:
                self.fixture_port_reservation = probe
                self.addCleanup(self.release_attachment_port_reservation)
            else:
                probe.close()
            return task
        self.fail("no free synthetic bridge port is available for the attachment fixture")

    def release_attachment_port_reservation(self):
        reservation = getattr(self, "fixture_port_reservation", None)
        if reservation is not None:
            reservation.close()
            self.fixture_port_reservation = None

    def install_attachment_fixture(self, targets=(), task="attach-check", allow_occupied_port=False):
        self.release_attachment_port_reservation()
        self.attachment_task = (
            task if allow_occupied_port else self.available_attachment_task(task, reserve=True)
        )
        self.install_fake_packages()
        mcp_entry = self.home / ".npm-global/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
        mcp_entry.write_text("process.title = 'chrome-devtools-mcp'; setInterval(() => {}, 1000);\n")
        owner = self
        self.probes = []
        (self.home / 'inspection-calls.jsonl').unlink(missing_ok=True)

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                owner.probes.append(self.path)
                if self.path == "/json/version":
                    value = {"Browser": "Chrome/150.0", "webSocketDebuggerUrl":
                             f"ws://127.0.0.1:{self.server.server_port}/devtools/browser/synthetic"}
                else:
                    value = [{"type": "page", "url": "about:blank", "title": "private-title-marker"}]
                if hasattr(owner, "endpoint_override"):
                    value = owner.endpoint_override(self.path, value)
                body = json.dumps(value).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.cdp = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=self.cdp.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.cdp.server_close)
        self.addCleanup(self.cdp.shutdown)
        self.allocation = self.prepare_profile(task=self.attachment_task, targets=targets)
        self.mock_path = self.home / "mock-inspection.json"
        self.mock = {"receipt": self.allocation["receipt"], "port": self.cdp.server_port,
                     "repo": str(self.repo.resolve()), "browser_pid": 123456789,
                     "shell_pid": os.getpid(),
                     "browser_start": f"{int(time.time())}:{int(time.time() % 1 * 1000000)}"}
        self.mock_path.write_text(json.dumps(self.mock))
        scripts = self.home / ".agents/skills/browser-routing/scripts"
        shutil.copyfile(scripts / "browser-inspect.py", scripts / "browser-inspect-real.py")
        (scripts / "browser-inspect.py").write_text(textwrap.dedent("""\
            import importlib.util, json, os, pathlib, sys, time
            path = pathlib.Path(__file__).with_name('browser-inspect-real.py')
            spec = importlib.util.spec_from_file_location('real_inspect', path)
            real = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(real)
            mock = json.loads((pathlib.Path(os.environ['HOME']) / 'mock-inspection.json').read_text())
            value = json.loads(pathlib.Path(mock['receipt']).read_text())['value']
            op, *args = sys.argv[1:]
            time.sleep(mock.get('inspection_delay', 0))
            calls_path = pathlib.Path(os.environ['HOME']) / 'inspection-calls.jsonl'
            with calls_path.open('a') as calls:
                calls.write(json.dumps({'op': op, 'args': args}) + '\\n')
            if op == 'record' and int(args[0]) == mock['browser_pid']:
                observed_records = sum(
                    call['op'] == 'record' and call['args'] == [str(mock['browser_pid'])]
                    for call in (json.loads(line) for line in calls_path.read_text().splitlines())
                )
                gone = mock.get('browser_gone') and not (
                    mock.get('pid_reappears') and observed_records >= 3)
                result = None if gone else {
                    'pid': mock['browser_pid'], 'ppid': 1, 'uid': mock.get('browser_uid', os.getuid()),
                    'exe': real.CHROME, 'start': mock['browser_start'],
                    'argv': [real.CHROME, '--disable-sync', '--disable-extensions',
                             '--use-mock-keychain', '--password-store=basic',
                             '--no-first-run', '--no-default-browser-check',
                             '--user-data-dir=' + value['profile'],
                             '--remote-debugging-port=' + str(mock['port']),
                             '--remote-debugging-address=127.0.0.1', 'about:blank'] + mock.get('extra_args', [])}
            elif op == 'record':
                result = real.record(int(args[0]))
                if result:
                    result['tpgid'] = result['pgid']
                    if int(args[0]) == mock['shell_pid']:
                        result['exe'] = '/bin/zsh'
                    if len(result['argv']) > 1 and result['argv'][1].endswith('chrome-devtools-axi-bridge.js') and mock.get('detached_bridge'):
                        result['pgid'] += 1
            elif op == 'trusted-chrome':
                result = True
            elif op == 'listeners' and int(args[0]) == mock['port']:
                observed_listeners = sum(
                    call['op'] == 'listeners' and call['args'] == [str(mock['port'])]
                    for call in (json.loads(line) for line in calls_path.read_text().splitlines())
                )
                listener_is_empty = mock.get('browser_gone') and not mock.get('listener_survives') and not (
                    mock.get('listener_reappears') and observed_listeners >= 2)
                result = [] if listener_is_empty else [
                    {'pid': mock.get('listener_pid', mock['browser_pid']),
                     'address': '127.0.0.1:' + str(mock['port'])}]
            elif op == 'listeners':
                # Mock the listener seam for the synthetic backend. State is
                # published by the fake bridge's actual listen callback.
                root = pathlib.Path(os.environ['HOME']) / '.chrome-devtools-axi/sessions'
                result = []
                for state in root.glob('*/bridge.pid'):
                    info = json.loads(state.read_text())
                    if info['port'] == int(args[0]) and real.record(info['pid']):
                        result.append({'pid': info['pid'], 'address': '127.0.0.1:' + args[0]})
            elif op == 'herdr':
                pane_id = os.environ['HERDR_PANE_ID'] if 'current' in args else args[-1]
                owner = (value.get('binding') or {}).get('owner')
                guard_pid = owner['guard']['pid'] if owner and pane_id == owner['pane'] else os.getppid()
                guard = real.record(guard_pid)
                # An exited bridge is not the current foreground command in its
                # retained shell. Model the new invocation, not stale ownership.
                if guard is None:
                    guard_pid = os.getppid()
                    guard = real.record(guard_pid)
                if 'process-info' in args:
                    result = {'process_info': {'pane_id': pane_id, 'shell_pid': guard['ppid'],
                              'foreground_process_group_id': guard['pgid'],
                              'foreground_processes': [{'pid': guard_pid}]}}
                else:
                    pane = {'pane_id': pane_id, 'workspace_id': os.environ['HERDR_WORKSPACE_ID'],
                            'tab_id': os.environ['HERDR_TAB_ID'], 'cwd': mock['repo'],
                            'foreground_cwd': mock.get('foreground_cwd', mock['repo'])}
                    if mock.get('agent'): pane['agent'] = mock['agent']
                    result = {'pane': pane}
            elif op == 'profile-users':
                result = mock.get('profile_users', [])
            elif op == 'profile-users-summary':
                if mock.get('summary_unavailable'):
                    sys.stderr.write('private-inspector-error-marker')
                    sys.exit(78)
                result = mock.get('profile_summary', {
                    'status': 'complete', 'counts': {'enumerated': 1, 'inspected_same_uid': 1,
                    'known_foreign_uid': 0, 'confirmed_gone': 0, 'matching_profile': 1, 'unknown_live': 0},
                    'failures': []})
            else:
                result = real.main([op, *args])
            print(json.dumps(result))
            """))
        axi_dir = self.home / ".npm-global/lib/node_modules/chrome-devtools-axi/dist"
        (axi_dir / "src").mkdir()
        (axi_dir / "src/client.js").write_text(textwrap.dedent("""\
            import { writeFileSync } from 'node:fs';
            function spawnBridgeProcess() {}
            export async function ensureBridge(spawnBridge = spawnBridgeProcess, notice) {
                writeFileSync(process.env.HOME + '/detached-fallback', 'unsafe');
                throw new Error('original detached fallback ran');
            }
            export async function stopBridge() { throw new Error('unsafe group stop'); }
            export async function callTool(name, args = {}) {
                const port = await ensureBridge();
                return await (await fetch(`http://127.0.0.1:${port}/call`)).json();
            }
            """))
        (axi_dir / "src/cli.js").write_text(textwrap.dedent("""\
            import { callTool } from './client.js';
            import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
            export async function main({ argv }) {
                const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
                    name.startsWith('CHROME_DEVTOOLS_AXI_') || name.startsWith('PLAYWRIGHT_')));
                appendFileSync(process.env.HOME + '/backend-calls.jsonl', JSON.stringify({args: argv, env}) + '\\n');
                const url = argv.slice(1).find(argument => !argument.startsWith('--'));
                const result = argv[0] === 'open'
                    ? await callTool('navigate_page', {type: 'url', url})
                    : argv[0] === 'newpage'
                        ? await callTool('new_page', {url})
                        : await callTool('list_pages');
                writeFileSync(process.env.HOME + '/backend-action-complete', 'complete');
                const mock = JSON.parse(readFileSync(process.env.HOME + '/mock-inspection.json'));
                if (mock.backend_error) throw new Error('raw-secret-bearing-exception-marker');
                process.stdout.write(JSON.stringify(result) + '\\n');
                if (mock.backend_output_size)
                    process.stdout.write('bounded-output-secret-marker' + 'x'.repeat(mock.backend_output_size));
            }
            """))
        bridge = axi_dir / "bin/chrome-devtools-axi-bridge.js"
        (axi_dir / "src/bridge.js").write_text(textwrap.dedent("""\
            export function mockSpec() {
                const mcpPath = process.env.CHROME_DEVTOOLS_AXI_MCP_PATH;
                const mcpArgs = ['prefix', 'shim', '--browserUrl=' + process.env.CHROME_DEVTOOLS_AXI_BROWSER_URL];
                return { command: process.execPath, args: [mcpPath, ...mcpArgs.slice(2)], };
            }
            """))
        bridge.write_text(textwrap.dedent("""\
            import { spawn } from 'node:child_process';
            import { mkdirSync, writeFileSync } from 'node:fs';
            import { join } from 'node:path';
            import { createServer } from 'node:http';
            import { mockSpec } from '../src/bridge.js';
            const spec = mockSpec();
            const safeEnv = Object.fromEntries(['HOME', 'PATH', 'LOGNAME', 'SHELL', 'TERM', 'USER']
                .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
            const child = spawn(spec.command, spec.args, {env: {...safeEnv, ...spec.env}, stdio: 'ignore'});
            const session = process.env.CHROME_DEVTOOLS_AXI_SESSION;
            const port = Number(process.env.CHROME_DEVTOOLS_AXI_PORT);
            const server = createServer((request, response) => {
                response.writeHead(200, {'content-type': 'application/json'});
                response.end(JSON.stringify({status: 'ok', session, proof: 'backend-output-secret-marker'}));
            });
            server.listen(port, '127.0.0.1', () => {
                const state = join(process.env.HOME, '.chrome-devtools-axi', 'sessions', session);
                mkdirSync(state, {recursive: true});
                writeFileSync(join(state, 'bridge.pid'), JSON.stringify({pid: process.pid, port}));
            });
            process.on('SIGTERM', () => { child.kill(); server.close(() => process.exit(0)); });
            """))

    def attach_env(self, pane="wA:p1"):
        env = self.env.copy()
        env.update({"HERDR_ENV": "1", "HERDR_SESSION": "qa", "HERDR_WORKSPACE_ID": "wA",
                    "HERDR_TAB_ID": "wA:t1", "HERDR_PANE_ID": pane})
        return env

    def attach_args(self, command="snapshot", *extra):
        return ["--repo-qa", self.attachment_task, "attach", self.allocation["receipt"],
                "--pid", str(self.mock["browser_pid"]), "--port", str(self.mock["port"]), command, *extra]

    def retain_attachment_diagnostics(self, process, output, started, timeout, phase="startup"):
        def sanitize(value):
            for marker in (str(self.home), str(self.repo), "private-title-marker", "private-marker"):
                value = value.replace(marker, "<redacted>")
            return value

        diagnostic = {
            "phase": phase,
            "elapsed": round(time.monotonic() - started, 3),
            "timeout": timeout,
            "returncode": process.poll(),
            "stdout": sanitize(output["stdout"]),
            "stderr": sanitize(output["stderr"]),
            "owned_processes": [],
        }
        try:
            spec = importlib.util.spec_from_file_location("owned_inspect", POLICY.parent / "browser-inspect.py")
            real = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(real)
            pending = [process.pid]
            state = self.session_state_dir(self.attachment_task) / "bridge.pid"
            if state.exists():
                info = json.loads(state.read_text())
                diagnostic["bridge_state"] = {key: info[key] for key in ("pid", "port")}
                pending.append(info["pid"])
            seen = set()
            while pending:
                pid = pending.pop()
                if pid in seen:
                    continue
                seen.add(pid)
                record = real.record(pid)
                if record is None or record["pgid"] != process.pid:
                    diagnostic["owned_processes"].append({"pid": pid, "in_owned_group": False})
                    continue
                summary = {key: record[key] for key in ("pid", "ppid", "pgid", "start")}
                summary["executable"] = pathlib.Path(record["exe"]).name
                summary["argv_program"] = pathlib.Path(record["argv"][0]).name
                summary["argv_script"] = pathlib.Path(record["argv"][1]).name if len(record["argv"]) > 1 else None
                diagnostic["owned_processes"].append(summary)
                pending.extend(real.main(["children", str(pid)]))
        except Exception as error:
            diagnostic["inspection_error"] = type(error).__name__
        directory = pathlib.Path(tempfile.mkdtemp(prefix="browser-policy-attachment-"))
        path = directory / f"{phase}.json"
        path.write_text(json.dumps(diagnostic, indent=2))
        path.chmod(0o600)
        return path

    def start_attachment_bridge(self, env=None, timeout=None):
        self.release_attachment_port_reservation()
        # The public CLI allows three seconds per inspection, then ten seconds
        # for bridge startup. This fixture has 12 preflight inspections and two
        # 10-inspection bridge verification passes, with two preflight HTTP
        # probes and one per pass (1.5 seconds each). A whole-launch 12-second
        # wait can expire while the unchanged guard is still verifying ownership.
        timeout = timeout if timeout is not None else 12 * 3 + 2 * 1.5 + 10 + 2 * (10 * 3 + 1.5)
        started = time.monotonic()
        process = subprocess.Popen([str(LAUNCHER), *self.attach_args("bridge")],
                                   cwd=self.repo, env=env or self.attach_env(), text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        self.addCleanup(process.stdout.close)
        self.addCleanup(process.stderr.close)
        self.addCleanup(self.stop_test_owned_process, process)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        output = {"stdout": "", "stderr": ""}
        deadline = started + timeout
        try:
            while time.monotonic() < deadline:
                for key, _ in selector.select(timeout=0.05):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output[key.data] += chunk.decode("utf-8", errors="replace")
                if "Verified foreground attached bridge ready" in output["stdout"]:
                    return process
                if process.poll() is not None:
                    remaining, error = process.communicate()
                    output["stdout"] += remaining
                    output["stderr"] += error
                    diagnostic = self.retain_attachment_diagnostics(process, output, started, timeout)
                    self.fail(f"foreground bridge failed (exit {process.returncode}); diagnostics: {diagnostic}")
            diagnostic = self.retain_attachment_diagnostics(process, output, started, timeout)
            self.fail(f"foreground bridge did not start; diagnostics: {diagnostic}")
        finally:
            selector.close()

    def wait_attachment_bridge(self, process, timeout=None):
        # A queued monitor tick can run before Node dispatches the child's exit.
        # Allow two bounded proof cycles: 15 inspections at three seconds each,
        # plus three HTTP probes at 1.5 seconds each, per cycle.
        timeout = timeout if timeout is not None else 2 * (15 * 3 + 3 * 1.5)
        started = time.monotonic()
        try:
            return process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            output = {"stdout": error.stdout or b"", "stderr": error.stderr or b""}
            output = {name: value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
                      for name, value in output.items()}
            diagnostic = self.retain_attachment_diagnostics(process, output, started, timeout, phase="shutdown")
            self.fail(f"foreground bridge did not exit; diagnostics: {diagnostic}")

    def test_attachment_foreground_public_cli_neutralizes_env_and_never_detaches(self):
        self.install_attachment_fixture()
        env = self.attach_env()
        env.update({"CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH": "private-marker",
                    "CHROME_DEVTOOLS_AXI_HEADED": "1", "PLAYWRIGHT_BROWSERS_PATH": "private-marker"})
        bridge = self.start_attachment_bridge(env)
        result = self.invoke(*self.attach_args(), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("backend-output-secret-marker", result.stdout)
        self.assertNotIn("private-title-marker", result.stdout + result.stderr)
        calls = [json.loads(line) for line in (self.home / "backend-calls.jsonl").read_text().splitlines()]
        self.assertNotIn("CHROME_DEVTOOLS_AXI_HEADED", calls[0]["env"])
        self.assertNotIn("CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH", calls[0]["env"])
        self.assertNotIn("PLAYWRIGHT_BROWSERS_PATH", calls[0]["env"])
        self.assertEqual(calls[0]["env"]["CHROME_DEVTOOLS_AXI_BROWSER_URL"], f"http://127.0.0.1:{self.mock['port']}")
        self.assertFalse((self.home / "detached-fallback").exists())
        bridge.terminate()
        self.wait_attachment_bridge(bridge)
        result = self.invoke(*self.attach_args(), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 78)
        self.assertFalse((self.home / "detached-fallback").exists())

    def rewrite_signed_receipt(self, update):
        receipt = pathlib.Path(self.allocation["receipt"])
        signed = json.loads(receipt.read_text())
        update(signed["value"])
        payload = json.dumps(signed["value"], separators=(",", ":"), ensure_ascii=False)
        key = (receipt.parent.parent / "key").read_bytes()
        signed["signature"] = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
        receipt.write_text(json.dumps(signed))

    def test_allocation_target_allowlist_tampering_and_old_schema_are_retained(self):
        self.allocation = self.prepare_profile(targets=["http://127.0.0.1:3011"])
        receipt = pathlib.Path(self.allocation["receipt"])
        profile = pathlib.Path(self.allocation["profile"])
        signed = json.loads(receipt.read_text())
        signed["value"]["origins"].append("http://127.0.0.1:3013")
        receipt.write_text(json.dumps(signed))

        result = self.invoke(
            "--repo-qa", "attach-check", "attach", str(receipt),
            "--pid", "123", "--port", "9222", "snapshot",
        )
        self.assertEqual(result.returncode, 78)
        self.assertIn("provenance", result.stderr)
        self.assertTrue(receipt.exists())
        self.assertTrue(profile.is_dir())

        def downgrade(value):
            value["origin"] = value.pop("origins")[0]
            value["version"] = 1

        self.rewrite_signed_receipt(downgrade)
        result = self.invoke(
            "--repo-qa", "attach-check", "attach", str(receipt),
            "--pid", "123", "--port", "9222", "snapshot",
        )
        self.assertEqual(result.returncode, 78)
        self.assertIn("schema is unsupported", result.stderr)
        self.assertTrue(receipt.exists())
        self.assertTrue(profile.is_dir())

    def test_attachment_refuses_unsafe_actual_argv_and_listener_before_http(self):
        self.install_attachment_fixture()
        for extra in ["--no-sandbox", "--disable-setuid-sandbox", "--proxy-server=private-marker",
                      "--load-extension=private-marker", "--user-data-dir=private-marker",
                      "--remote-debugging-port=9999", "--remote-allow-origins=*", "https://private-marker"]:
            self.mock["extra_args"] = [extra]
            self.mock_path.write_text(json.dumps(self.mock))
            result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
            self.assertEqual(result.returncode, 78)
            self.assertNotIn("private-marker", result.stdout + result.stderr)
            self.assertEqual(self.probes, [])
        self.mock.pop("extra_args")
        self.mock["listener_pid"] = 1
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(self.probes, [])
        self.assertFalse(self.session_state_dir(self.attachment_task).exists())

    def test_attachment_foreign_endpoint_metadata_is_never_emitted(self):
        self.install_attachment_fixture()
        for kind in ["transport", "target"]:
            self.endpoint_override = lambda path, value: (
                {**value, "webSocketDebuggerUrl": "ws://private-marker:9222/devtools/browser/private-marker"}
                if path == "/json/version" and kind == "transport" else
                [{"type": "page", "url": "https://private-marker", "title": "private-title-marker"}]
                if path == "/json/list" and kind == "target" else value)
            result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
            self.assertEqual(result.returncode, 78)
            self.assertNotIn("private-marker", result.stdout + result.stderr)
            self.assertNotIn("private-title-marker", result.stdout + result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_stop_before_binding_is_launch_free_and_scope_independent(self):
        self.install_attachment_fixture()
        self.endpoint_override = lambda path, value: (
            [{"type": "other", "url": "chrome://private-marker/", "title": "private-title-marker"}]
            if path == "/json/list" else value)
        result = self.invoke(*self.attach_args("stop"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("No owned foreground bridge", result.stdout)
        self.assertEqual(self.probes, [], "stop must not depend on endpoint readiness")
        self.assertFalse(self.session_state_dir(self.attachment_task).exists())
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_stop_with_failed_binding_checks_resource_ownership_without_targets(self):
        self.install_attachment_fixture()
        self.endpoint_override = lambda path, value: (
            [{"type": "page", "url": "https://private-marker/"}]
            if path == "/json/list" else value)
        self.rewrite_signed_receipt(lambda value: value.update(binding={
            "pid": self.mock["browser_pid"], "port": self.mock["port"],
            "start": self.mock["browser_start"], "owner": None, "bridge": None}))
        result = self.invoke(*self.attach_args("stop"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertIn("foreground bridge", result.stderr)
        self.assertNotIn("non-synthetic target", result.stderr)
        self.assertEqual(self.probes, [])
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_unbound_stop_retains_busy_allocation(self):
        self.install_attachment_fixture()
        lock = pathlib.Path(self.allocation["receipt"]).parent / "lock"
        lock.mkdir(mode=0o700)
        result = self.invoke(*self.attach_args("stop"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertIn("busy", result.stderr)
        self.assertTrue(lock.exists())
        self.assertEqual(self.probes, [])

    def test_attachment_diagnose_after_chrome_exit_is_readonly_and_reports_inventory_without_targets(self):
        self.install_attachment_fixture()
        self.mock['browser_gone'] = True
        expected_inventory = {'status': 'incomplete', 'counts': {
            'enumerated': 3, 'inspected_same_uid': 2, 'known_foreign_uid': 1,
            'confirmed_gone': 0, 'matching_profile': 1, 'unknown_live': 1},
            'failures': [{'stage': 'procargs_read', 'reason': 'unavailable', 'errno': 1, 'count': 1}]}
        self.mock['profile_summary'] = expected_inventory
        self.mock_path.write_text(json.dumps(self.mock))
        receipt = pathlib.Path(self.allocation['receipt'])
        self.rewrite_signed_receipt(lambda value: value.update(
            created=value['created'] - 7200001, expires=value['expires'] - 7200001))
        before = receipt.read_bytes()

        result = self.invoke(*self.attach_args('diagnose'), env=self.attach_env())

        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report, {
            'version': 1,
            'process': {'requested_pid_absent': True},
            'listener': {'requested_port_empty': True},
            'targets': {'status': 'not_observed', 'initial_target': 'not_proven'},
            'inventory': expected_inventory,
        })
        self.assertEqual(receipt.read_bytes(), before)
        self.assertTrue(pathlib.Path(self.allocation['profile']).exists())
        self.assertEqual(self.probes, [], 'post-stop diagnosis must not request CDP endpoints')
        self.assertFalse((self.home / 'backend-calls.jsonl').exists())
        calls = [json.loads(line) for line in (self.home / 'inspection-calls.jsonl').read_text().splitlines()]
        relevant = [(call['op'], call['args'][0] if call['args'] else None) for call in calls
                    if (call['op'] == 'record' and call['args'] == [str(self.mock['browser_pid'])])
                    or (call['op'] == 'listeners' and call['args'] == [str(self.mock['port'])])
                    or call['op'] == 'profile-users-summary']
        self.assertEqual(relevant[:6], [
            ('record', str(self.mock['browser_pid'])),
            ('record', str(self.mock['browser_pid'])),
            ('listeners', str(self.mock['port'])),
            ('profile-users-summary', str(self.allocation['profile'])),
            ('record', str(self.mock['browser_pid'])),
            ('listeners', str(self.mock['port'])),
        ])
        self.assertEqual(sum(op == 'profile-users-summary' for op, _ in relevant), 1)

    def test_attachment_diagnose_after_exit_refuses_reused_pid_and_nonempty_listener(self):
        self.install_attachment_fixture(task='diagnose-after-exit-refusal')
        for condition in ('pid_reappears', 'listener_survives', 'listener_reappears'):
            with self.subTest(condition=condition):
                self.mock['browser_gone'] = True
                self.mock['pid_reappears'] = condition == 'pid_reappears'
                self.mock['listener_survives'] = condition == 'listener_survives'
                self.mock['listener_reappears'] = condition == 'listener_reappears'
                self.mock_path.write_text(json.dumps(self.mock))
                (self.home / 'inspection-calls.jsonl').unlink(missing_ok=True)
                self.probes.clear()
                before = pathlib.Path(self.allocation['receipt']).read_bytes()
                result = self.invoke(*self.attach_args('diagnose'), env=self.attach_env())
                self.assertEqual(result.returncode, 78)
                self.assertEqual(result.stdout, '')
                self.assertNotIn('private-', result.stderr)
                self.assertEqual(self.probes, [])
                self.assertEqual(pathlib.Path(self.allocation['receipt']).read_bytes(), before)
                self.assertTrue(pathlib.Path(self.allocation['profile']).exists())

    def test_attachment_diagnose_after_exit_checks_allocation_identity_before_inventory(self):
        self.install_attachment_fixture()
        receipt = pathlib.Path(self.allocation['receipt'])
        profile = pathlib.Path(self.allocation['profile'])
        for invalidation in ('wrong_task', 'wrong_repo', 'receipt_symlink', 'profile_inode'):
            with self.subTest(invalidation=invalidation):
                if invalidation == 'wrong_task':
                    args = self.attach_args('diagnose')
                    args[1] = 'different-task'
                    result = self.invoke(*args, env=self.attach_env())
                elif invalidation == 'wrong_repo':
                    self.rewrite_signed_receipt(lambda value: value.update(repo=str(self.home)))
                    result = self.invoke(*self.attach_args('diagnose'), env=self.attach_env())
                    self.rewrite_signed_receipt(lambda value: value.update(repo=str(self.repo.resolve())))
                elif invalidation == 'receipt_symlink':
                    retained = receipt.with_name('retained-receipt.json')
                    receipt.rename(retained)
                    receipt.symlink_to(retained)
                    result = self.invoke(*self.attach_args('diagnose'), env=self.attach_env())
                    receipt.unlink()
                    retained.rename(receipt)
                else:
                    retained = profile.with_name('retained-profile')
                    profile.rename(retained)
                    profile.mkdir(mode=0o700)
                    result = self.invoke(*self.attach_args('diagnose'), env=self.attach_env())
                    profile.rmdir()
                    retained.rename(profile)
                self.assertEqual(result.returncode, 78)
                self.assertEqual(result.stdout, '')
                self.assertFalse((self.home / 'inspection-calls.jsonl').exists())
                self.assertEqual(self.probes, [])

    def test_attachment_diagnose_classifies_targets_without_releasing_metadata_or_binding(self):
        self.install_attachment_fixture()
        self.endpoint_override = lambda path, value: [
            {"type": "page", "url": "about:blank", "title": "private-title-marker", "id": "private-id-marker"},
            {"type": "other", "url": "chrome://private-marker/", "title": "private-title-marker"},
            {"type": "page", "url": "https://private-marker/", "id": "private-id-marker"},
            {"type": "private-type-marker", "url": "chrome://private-marker/"},
        ] if path == "/json/list" else value
        before = pathlib.Path(self.allocation["receipt"]).read_bytes()
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        histogram = report["targets"].pop("rejected_type_counts")
        self.assertEqual(histogram["unsupported_type"]["unknown"], 1)
        self.assertEqual(sum(histogram["unsupported_type"].values()), 1)
        self.assertEqual(histogram["foreign_target"]["page"], 1)
        self.assertEqual(sum(histogram["foreign_target"].values()), 1)
        self.assertEqual(report["targets"], {
            "status": "blocked", "reason": "scope_refused", "counts": {
                "permitted_page": 1, "permitted_worker": 0,
                "internal_page": 0, "internal_non_page": 1,
                "foreign_target": 1, "unsupported_type": 1, "malformed_target": 0,
            }})
        for marker in ["private-marker", "private-title-marker", "private-id-marker", "private-type-marker"]:
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertEqual(pathlib.Path(self.allocation["receipt"]).read_bytes(), before)
        self.assertFalse(self.session_state_dir(self.attachment_task).exists())
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_rejected_types_are_bounded_categories_only(self):
        self.install_attachment_fixture()
        self.endpoint_override = lambda path, value: [
            {"type": "page", "url": "about:blank"},
            {"type": "tab", "url": "https://private-url-marker/", "id": "private-id-marker"},
            {"type": "iframe", "url": "https://private-url-marker/"},
            {"type": "worker", "url": "https://private-url-marker/"},
        ] if path == "/json/list" else value
        before = pathlib.Path(self.allocation["receipt"]).read_bytes()
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        targets = json.loads(result.stdout)["targets"]
        self.assertEqual(targets["status"], "blocked")
        self.assertEqual(targets["reason"], "scope_refused")
        self.assertEqual(targets["rejected_type_counts"], {
            "unsupported_type": {"page": 0, "service_worker": 0, "worker": 0,
                "other": 0, "browser": 0, "tab": 1, "iframe": 1,
                "background_page": 0, "shared_worker": 0, "unknown": 0},
            "foreign_target": {"page": 0, "service_worker": 0, "worker": 1,
                "other": 0, "browser": 0, "tab": 0, "iframe": 0,
                "background_page": 0, "shared_worker": 0, "unknown": 0},
        })
        for marker in ["private-url-marker", "private-id-marker"]:
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertEqual(pathlib.Path(self.allocation["receipt"]).read_bytes(), before)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_collapses_arbitrary_type_strings_without_leaks(self):
        self.install_attachment_fixture()
        markers = ["private-type-marker", "https://private-host-marker/", "__proto__",
                   "constructor", 'private-quote-marker"', "private-control-marker\n\x01",
                   "private-long-marker" + "x" * 10000]
        self.endpoint_override = lambda path, value: [
            {"type": "page", "url": "about:blank"},
            *[{"type": marker, "url": "https://private-url-marker/",
               "title": "private-title-marker", "id": "private-id-marker"} for marker in markers],
        ] if path == "/json/list" else value
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        targets = json.loads(result.stdout)["targets"]
        self.assertEqual(targets["status"], "blocked")
        self.assertEqual(targets["counts"]["unsupported_type"], 7)
        histogram = targets["rejected_type_counts"]
        self.assertEqual(histogram["unsupported_type"]["unknown"], 7)
        self.assertEqual(sum(histogram["unsupported_type"].values()), 7)
        self.assertEqual(sum(histogram["foreign_target"].values()), 0)
        expected_keys = {"page", "service_worker", "worker", "other", "browser", "tab",
                         "iframe", "background_page", "shared_worker", "unknown"}
        for category in histogram.values():
            self.assertEqual(set(category), expected_keys)
        for marker in [*markers, "private-url-marker", "private-title-marker", "private-id-marker"]:
            self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_ready_scope_and_malformed_targets_keep_admission(self):
        self.install_attachment_fixture()
        for pages, status, reason, malformed in [
            ([{"type": "page", "url": "about:blank"}], "ready", "ready", 0),
            ([None, {"type": 3, "url": "private-marker"}], "blocked", "scope_refused", 2),
            ({"private-list-marker": True}, "blocked", "invalid_list", 0),
        ]:
            with self.subTest(reason=reason):
                self.endpoint_override = lambda path, value: pages if path == "/json/list" else value
                result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
                self.assertEqual(result.returncode, 0, result.stderr)
                targets = json.loads(result.stdout)["targets"]
                self.assertEqual(targets["status"], status)
                self.assertEqual(targets["reason"], reason)
                self.assertEqual(targets["counts"]["malformed_target"], malformed)
                self.assertEqual(sum(sum(category.values()) for category in targets["rejected_type_counts"].values()), 0)
                self.assertNotIn("private-marker", result.stdout + result.stderr)
                self.assertNotIn("private-list-marker", result.stdout + result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_reports_inventory_unknown_without_claiming_absence(self):
        self.install_attachment_fixture()
        expected = {"status": "incomplete", "counts": {
            "enumerated": 2, "inspected_same_uid": 2, "known_foreign_uid": 0,
            "confirmed_gone": 0, "matching_profile": 1, "unknown_live": 1},
            "failures": [
                {"stage": "procargs_size", "reason": "unavailable", "errno": 1, "count": 1},
                {"stage": "identity_reprobe", "reason": "unavailable", "errno": 1, "count": 1},
            ]}
        self.mock["profile_summary"] = {**expected, "argv": ["private-argv-marker"], "env": {"SECRET": "private-env-marker"}}
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["inventory"], expected)
        self.assertNotIn("private-", result.stdout + result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_withholds_report_when_profile_identity_changes(self):
        self.install_attachment_fixture()
        profile = pathlib.Path(self.allocation["profile"])
        def replace(path, value):
            if path == "/json/list":
                profile.rename(profile.with_name("retained-fixture"))
                profile.mkdir(mode=0o700)
            return value
        self.endpoint_override = replace
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(result.stdout, "")
        self.assertIn("profile identity changed", result.stderr)

    def test_attachment_diagnose_keeps_failed_inventory_unknown_without_error_values(self):
        self.install_attachment_fixture()
        self.mock["summary_unavailable"] = True
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["inventory"], {
            "status": "incomplete", "counts": None,
            "failures": [{"stage": "inspector", "reason": "unavailable", "errno": None, "count": 1}]})
        self.assertNotIn("private-inspector-error-marker", result.stdout + result.stderr)

    def test_attachment_diagnose_and_unbound_stop_refuse_bad_ownership_before_endpoint(self):
        self.install_attachment_fixture()
        baseline = self.mock.copy()
        for override in [
            {"browser_uid": os.getuid() + 1}, {"browser_start": "1:0"},
            {"extra_args": ["--user-data-dir=/private-marker"]},
            {"listener_pid": 999}, {"foreground_cwd": str(self.home)},
        ]:
            self.mock_path.write_text(json.dumps({**baseline, **override}))
            for command in ["diagnose", "stop"]:
                with self.subTest(override=next(iter(override)), command=command):
                    result = self.invoke(*self.attach_args(command), env=self.attach_env())
                    self.assertEqual(result.returncode, 78)
                    self.assertEqual(result.stdout, "")
                    self.assertNotIn("private-marker", result.stderr)
                    self.assertEqual(self.probes, [])
        self.assertTrue(pathlib.Path(self.allocation["profile"]).exists())
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_diagnose_withholds_report_after_process_identity_changes(self):
        self.install_attachment_fixture()
        def change_start(path, value):
            if path == "/json/list":
                sec, usec = self.mock["browser_start"].split(":")
                self.mock["browser_start"] = f"{int(sec) + 1}:{usec}"
                self.mock_path.write_text(json.dumps(self.mock))
            return value
        self.endpoint_override = change_start
        result = self.invoke(*self.attach_args("diagnose"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(result.stdout, "")
        self.assertIn("process changed", result.stderr)

    def test_attachment_wrong_workspace_refuses_before_chrome_metadata_or_backend(self):
        self.install_attachment_fixture()
        owner = {
            "session": "qa", "workspace": "wA", "tab": "wA:t1", "pane": "wA:p1",
            "guard": {"pid": self.mock["shell_pid"], "start": "1:1"},
            "shell": {"pid": self.mock["shell_pid"], "start": "1:1"},
        }
        self.rewrite_signed_receipt(lambda value: value.update(binding={
            "pid": self.mock["browser_pid"], "port": self.mock["port"],
            "start": self.mock["browser_start"], "owner": owner,
            "bridge": {"pid": self.mock["shell_pid"], "start": "1:1"},
        }))
        receipt = pathlib.Path(self.allocation["receipt"])
        before = receipt.read_bytes()
        env = self.attach_env("wB:p2")
        env.update({"HERDR_WORKSPACE_ID": "wB", "HERDR_TAB_ID": "wB:t1"})

        for command in ("snapshot", "diagnose"):
            with self.subTest(command=command):
                self.probes.clear()
                result = self.invoke(*self.attach_args(command), env=env)

                self.assertEqual(result.returncode, 78)
                self.assertIn("workspace", result.stderr)
                self.assertEqual(self.probes, [], "wrong-workspace caller must not read Chrome endpoints")
                self.assertFalse((self.home / "backend-calls.jsonl").exists())
                self.assertFalse((self.home / "detached-fallback").exists())
                self.assertFalse(self.session_state_dir(self.attachment_task).exists())
                self.assertEqual(receipt.read_bytes(), before)

        malformed_owner = {key: value for key, value in owner.items() if key != "workspace"}
        self.rewrite_signed_receipt(lambda value: value.update(binding={
            "pid": self.mock["browser_pid"], "port": self.mock["port"],
            "start": self.mock["browser_start"], "owner": malformed_owner,
            "bridge": {"pid": self.mock["shell_pid"], "start": "1:1"},
        }))
        before = receipt.read_bytes()
        self.probes.clear()
        result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))

        self.assertEqual(result.returncode, 78)
        self.assertIn("owner workspace is invalid", result.stderr)
        self.assertEqual(self.probes, [])
        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertEqual(receipt.read_bytes(), before)

    def test_attachment_requires_foreground_bridge_and_exact_herdr_placement(self):
        self.install_attachment_fixture()
        result = self.invoke(*self.attach_args(), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertIn("foreground bridge", result.stderr)
        self.mock["agent"] = "codex"
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertIn("ordinary owned foreground", result.stderr)
        self.mock.pop("agent")
        self.mock["foreground_cwd"] = str(self.home)
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertFalse(self.session_state_dir(self.attachment_task).exists())

    def test_attachment_stale_start_pid_reuse_and_foreign_uid_fail_closed(self):
        self.install_attachment_fixture()
        self.mock["browser_uid"] = os.getuid() + 1
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(self.probes, [])
        self.mock.pop("browser_uid")
        self.mock["browser_start"] = "1:0"
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertEqual(self.probes, [])
        owner = {"session": "qa", "workspace": "wA", "tab": "wA:t1", "pane": "wA:p1",
                 "guard": {"pid": self.mock["shell_pid"], "start": "1:1"},
                 "shell": {"pid": self.mock["shell_pid"], "start": "1:1"}}
        self.rewrite_signed_receipt(lambda value: value.update(binding={"pid": self.mock["browser_pid"],
            "port": self.mock["port"], "start": "1:1", "owner": owner,
            "bridge": {"pid": self.mock["shell_pid"], "start": "1:1"}}))
        self.mock["browser_start"] = f"{int(time.time())}:{int(time.time() % 1 * 1000000)}"
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args(), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 78)
        self.assertIn("reused PID", result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_allocation_symlinks_copies_modes_and_repo_mismatch(self):
        self.allocation = self.prepare_profile()
        receipt = pathlib.Path(self.allocation["receipt"])
        profile = pathlib.Path(self.allocation["profile"])
        def invoke():
            return self.invoke("--repo-qa", "attach-check", "attach", str(receipt), "--pid", "123", "--port", "9222", "snapshot")
        os.chmod(receipt, 0o644)
        self.assertEqual(invoke().returncode, 78)
        os.chmod(receipt, 0o600)
        copied = receipt.with_name("copy.json")
        shutil.copyfile(receipt, copied)
        result = self.invoke("--repo-qa", "attach-check", "attach", str(copied), "--pid", "123", "--port", "9222", "snapshot")
        self.assertEqual(result.returncode, 78)
        self.rewrite_signed_receipt(lambda value: value.update(repo=str(self.home)))
        self.assertEqual(invoke().returncode, 78)
        self.rewrite_signed_receipt(lambda value: value.update(repo=str(self.repo.resolve())))
        profile.rename(profile.with_name("retained"))
        profile.symlink_to(profile.with_name("retained"), target_is_directory=True)
        self.assertEqual(invoke().returncode, 78)
        profile.unlink()
        profile.mkdir(mode=0o700)
        self.assertEqual(invoke().returncode, 78)
        saved = receipt.with_name("saved.json")
        receipt.rename(saved)
        receipt.symlink_to(saved)
        self.assertEqual(invoke().returncode, 78)

    def test_attachment_expired_receipt_and_allocation_lock_refused(self):
        self.allocation = self.prepare_profile()
        self.rewrite_signed_receipt(lambda value: value.update(created=value["created"] - 7200001, expires=value["expires"] - 7200001))
        result = self.invoke("--repo-qa", "attach-check", "attach", self.allocation["receipt"], "--pid", "123", "--port", "9222", "snapshot")
        self.assertEqual(result.returncode, 78)
        self.assertIn("stale or retired", result.stderr)
        self.install_attachment_fixture()
        (pathlib.Path(self.allocation["receipt"]).parent / "lock").mkdir(mode=0o700)
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertIn("allocation is busy", result.stderr)

    def test_attachment_stop_and_cleanup_preserve_unrelated_resources(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        unrelated_process = subprocess.Popen([shutil.which("node"), "-e", "setInterval(() => {}, 1000)"], start_new_session=True)
        self.addCleanup(self.stop_test_owned_process, unrelated_process)
        unrelated = self.home / "unrelated-profile"
        unrelated.mkdir()
        sentinel = unrelated / "data"
        sentinel.write_text("preserve")
        result = self.invoke(*self.attach_args("stop"), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_attachment_bridge(bridge)
        self.assertTrue(pathlib.Path(self.allocation["profile"]).exists())
        result = self.invoke(*self.attach_args("cleanup"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.mock["browser_gone"] = True
        self.mock["profile_users"] = [999]
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("cleanup"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.mock["profile_users"] = []
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("cleanup"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(pathlib.Path(self.allocation["profile"]).exists())
        self.assertEqual(sentinel.read_text(), "preserve")
        self.assertIsNone(unrelated_process.poll())
        self.assertTrue(pathlib.Path(self.allocation["receipt"]).exists())

    def test_exact_procargs_parser_preserves_spaces_and_filters_private_environment(self):
        path = POLICY.parent / "browser-inspect.py"
        spec = importlib.util.spec_from_file_location("browser_inspect", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        argv = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "--user-data-dir=/a repository with spaces/profile", "about:blank"]
        data = struct.pack("=i", len(argv)) + b"/executable\0\0" + b"\0".join(arg.encode() for arg in argv) + b"\0"
        data += b"PRIVATE_TOKEN=private-marker\0CHROME_DEVTOOLS_AXI_WS_HEADERS=private-marker\0HERDR_PANE_ID=wA:p1\0\0"
        parsed, env, names = module.parse_procargs(data)
        self.assertEqual(parsed, argv)
        self.assertEqual(env, {"HERDR_PANE_ID": "wA:p1"})
        self.assertEqual(names, ["CHROME_DEVTOOLS_AXI_WS_HEADERS"])
        self.assertNotIn("private-marker", json.dumps(env))
        with self.assertRaises(ValueError):
            module.parse_procargs(b"bad")

    def test_attached_client_lifecycle_seam_stops_before_dead_bridge_fallback(self):
        attachment = (POLICY.parent / "browser-attachment.mjs").resolve().as_uri()
        source = textwrap.dedent("""\
            const spawnBridgeProcess = () => { globalThis.detached = true; };
            export async function ensureBridge(spawnBridge = spawnBridgeProcess, notice) { spawnBridge(); }
            export async function stopBridge() { globalThis.groupStop = true; }
            export async function callTool(name, args = {}) { return ensureBridge(); }
            """)
        script = f"const policy = await import({json.dumps(attachment)}); const source = {json.dumps(source)};" + textwrap.dedent("""\
            globalThis[Symbol.for('dotfiles.browser.attach.ensure')] = async () => { throw new Error('dead bridge'); };
            globalThis[Symbol.for('dotfiles.browser.attach.tool')] = async () => {};
            const module = await import('data:text/javascript,' + encodeURIComponent(policy.attachClientSource(source)));
            const results = await Promise.allSettled([module.callTool('list_pages'), module.stopBridge()]);
            let unsupported = false;
            try { policy.attachClientSource('unsupported source'); } catch { unsupported = true; }
            process.stdout.write(JSON.stringify({ statuses: results.map(r => r.status),
                detached: !!globalThis.detached, groupStop: !!globalThis.groupStop, unsupported }));
            """)
        result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script],
                                env=self.env, text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"statuses": ["rejected", "rejected"],
                         "detached": False, "groupStop": False, "unsupported": True})

    def test_prepare_profile_signs_multiple_explicit_target_origins(self):
        targets = ["http://127.0.0.1:3011", "http://localhost:3012"]
        result = self.invoke(
            "--repo-qa", "multi-target", "prepare-profile",
            "--target", targets[0], "--target", targets[1],
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        allocation = json.loads(result.stdout)
        signed = json.loads(pathlib.Path(allocation["receipt"]).read_text())
        self.assertEqual(signed["value"]["version"], 2)
        self.assertEqual(signed["value"]["origins"], targets)
        self.assertNotIn("origin", signed["value"])

    def test_prepare_profile_rejects_non_origin_target_suffixes(self):
        for target in [
            "http://127.0.0.1:3011?",
            "http://127.0.0.1:3011#",
            " http://127.0.0.1:3011",
        ]:
            result = self.invoke(
                "--repo-qa", "malformed-target", "prepare-profile", "--target", target
            )
            self.assertEqual(result.returncode, 78, target)

    def test_attachment_withholds_output_after_foreign_post_action_target(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        self.endpoint_override = lambda path, value: (
            [{"type": "page", "url": "https://foreign.test/", "title": "private-foreign-title-marker"}]
            if path == "/json/list" and (self.home / "backend-action-complete").exists()
            else value
        )

        result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))

        self.assertEqual(result.returncode, 78)
        self.assertNotIn("backend-output-secret-marker", result.stdout + result.stderr)
        self.assertNotIn("private-foreign-title-marker", result.stdout + result.stderr)
        self.assertTrue((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / "detached-fallback").exists())
        bridge.terminate()
        self.wait_attachment_bridge(bridge)

    def test_attachment_withholds_raw_backend_exception_values(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        self.mock["backend_error"] = True
        self.mock_path.write_text(json.dumps(self.mock))

        result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))

        self.assertEqual(result.returncode, 78)
        self.assertIn("backend output was withheld", result.stderr)
        self.assertNotIn("raw-secret-bearing-exception-marker", result.stdout + result.stderr)
        self.assertTrue((self.home / "backend-action-complete").exists())
        self.assertGreaterEqual(self.probes.count("/json/list"), 4)
        self.assertFalse((self.home / "detached-fallback").exists())
        bridge.terminate()
        self.wait_attachment_bridge(bridge)

    def test_attachment_bounds_backend_output_before_release(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        self.mock["backend_output_size"] = 256_001
        self.mock_path.write_text(json.dumps(self.mock))

        result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))

        self.assertEqual(result.returncode, 78)
        self.assertIn("bounded evidence limit", result.stderr)
        self.assertNotIn("bounded-output-secret-marker", result.stdout + result.stderr)
        self.assertTrue((self.home / "backend-action-complete").exists())
        self.assertFalse((self.home / "detached-fallback").exists())
        bridge.terminate()
        self.wait_attachment_bridge(bridge)

    def test_attachment_allows_two_declared_origins_in_one_private_profile(self):
        origins = ["http://127.0.0.1:3011", "http://localhost:3012"]
        self.install_attachment_fixture(
            targets=origins, task=self.available_attachment_task()
        )
        self.endpoint_override = lambda path, value: (
            [
                {"type": "page", "url": origins[0] + "/os"},
                {"type": "page", "url": origins[1] + "/dash"},
            ]
            if path == "/json/list"
            else value
        )
        bridge = self.start_attachment_bridge()
        receipt = json.loads(pathlib.Path(self.allocation["receipt"]).read_text())
        self.assertEqual(receipt["value"]["origins"], origins)
        self.assertTrue(pathlib.Path(self.allocation["profile"]).is_dir())

        for origin in origins:
            result = self.invoke(
                *self.attach_args("open", origin + "/"), env=self.attach_env("wA:p2")
            )
            self.assertEqual(result.returncode, 0, result.stderr)

        result = self.invoke(
            *self.attach_args("newpage", "--background", origins[0] + "/new-tab"),
            env=self.attach_env("wA:p2"),
        )
        self.assertEqual(result.returncode, 0, result.stderr)

        calls_before = len((self.home / "backend-calls.jsonl").read_text().splitlines())
        result = self.invoke(
            *self.attach_args("open", "http://127.0.0.1:3013/"),
            env=self.attach_env("wA:p2"),
        )
        self.assertEqual(result.returncode, 78)
        self.assertEqual(
            len((self.home / "backend-calls.jsonl").read_text().splitlines()), calls_before
        )
        self.assertIsNone(bridge.poll())

    def test_attachment_fixture_uses_an_available_identity_around_an_owned_port(self):
        task = "attach-check"
        port = self.session_port(task)
        with socket.socket() as owner:
            owner.bind(("127.0.0.1", port))
            owner.listen()
            self.install_attachment_fixture(task=task)

            self.assertNotEqual(self.attachment_task, task)
            bridge = self.start_attachment_bridge()
            try:
                self.assertIsNone(bridge.poll())
                self.assertEqual(owner.getsockname(), ("127.0.0.1", port))
            finally:
                bridge.terminate()
                self.wait_attachment_bridge(bridge)

    def test_attachment_guard_rejects_an_intentionally_occupied_fixture_port(self):
        task = "attach-check"
        port = self.session_port(task)
        with socket.socket() as owner:
            owner.bind(("127.0.0.1", port))
            owner.listen()
            self.install_attachment_fixture(task=task, allow_occupied_port=True)

            result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())

            self.assertEqual(result.returncode, 78)
            self.assertIn("task bridge state or port already exists", result.stderr)
            self.assertEqual(owner.getsockname(), ("127.0.0.1", port))
            self.assertFalse(self.session_state_dir(task).exists())
            self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_attachment_lifecycle_includes_bounded_inspection_time(self):
        self.install_attachment_fixture(task=self.available_attachment_task())
        # Each inspection remains below the guard's three-second limit, but
        # the 32 startup inspections exceed the old whole-launch 12-second wait.
        self.mock["inspection_delay"] = 0.4
        self.mock_path.write_text(json.dumps(self.mock))
        bridge = self.start_attachment_bridge()
        self.assertFalse((self.home / "detached-fallback").exists())
        # The monitor continues real OS inspection while the public stop command
        # verifies and closes the bridge. Its supervisor must finish that work.
        self.mock["inspection_delay"] = 0.6
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args("stop"), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.wait_attachment_bridge(bridge)
        self.assertTrue(pathlib.Path(self.allocation["profile"]).is_dir())

    def test_attachment_accepts_repository_paths_with_spaces_and_exact_target_origin(self):
        self.repo.rename(self.repo.with_name("repo with spaces"))
        self.repo = self.repo.with_name("repo with spaces")
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        result = self.invoke(*self.attach_args(), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.invoke(*self.attach_args("open", "https://private-marker"), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 78)
        self.assertNotIn("private-marker", result.stdout + result.stderr)
        bridge.terminate()
        self.wait_attachment_bridge(bridge)
        allocation = self.invoke("--repo-qa", "target", "prepare-profile", "--target", "http://127.0.0.1:3011")
        self.assertEqual(allocation.returncode, 0, allocation.stderr)
        for target in ["", "https://remote.test", "http://127.0.0.1", "http://127.0.0.1:3011/path", "http://user:private-marker@localhost:3011", "http://127.0.0.2:3011"]:
            result = self.invoke("--repo-qa", "target", "prepare-profile", "--target", target)
            self.assertEqual(result.returncode, 78)
            self.assertNotIn("private-marker", result.stdout + result.stderr)

        duplicate = self.invoke(
            "--repo-qa", "target", "prepare-profile",
            "--target", "http://127.0.0.1:3011",
            "--target", "http://127.0.0.1:3011",
        )
        self.assertEqual(duplicate.returncode, 78)
        too_many = ["--repo-qa", "target", "prepare-profile"]
        for port in range(3011, 3020):
            too_many.extend(("--target", f"http://127.0.0.1:{port}"))
        self.assertEqual(self.invoke(*too_many).returncode, 78)

    def test_attachment_lost_chrome_fails_foreground_proof_and_retains_profile(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        self.mock["browser_gone"] = True
        self.mock_path.write_text(json.dumps(self.mock))
        output, error = self.wait_attachment_bridge(bridge)
        self.assertEqual(bridge.returncode, 78, output + error)
        self.assertTrue(pathlib.Path(self.allocation["profile"]).exists())
        self.assertTrue(json.loads(pathlib.Path(self.allocation["receipt"]).read_text())["value"]["closed"])
        self.assertFalse((self.home / "detached-fallback").exists())

    def test_attachment_bridge_start_failure_retains_allocation_and_never_retries(self):
        self.install_attachment_fixture()
        bridge_script = self.home / ".npm-global/lib/node_modules/chrome-devtools-axi/dist/bin/chrome-devtools-axi-bridge.js"
        bridge_script.write_text("process.exit(37);\n")
        result = self.invoke(*self.attach_args("bridge"), env=self.attach_env())
        self.assertEqual(result.returncode, 78)
        self.assertTrue(pathlib.Path(self.allocation["profile"]).exists())
        self.assertTrue(json.loads(pathlib.Path(self.allocation["receipt"]).read_text())["value"]["closed"])
        self.assertFalse((self.home / "detached-fallback").exists())

    def test_attachment_foreign_workspace_and_detached_bridge_refused(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        env = self.attach_env("wB:p1")
        env.update(HERDR_WORKSPACE_ID="wB", HERDR_TAB_ID="wB:t1")
        result = self.invoke(*self.attach_args(), env=env)
        self.assertEqual(result.returncode, 78)
        self.assertIn("owned Herdr workspace", result.stderr)
        self.mock["detached_bridge"] = True
        self.mock_path.write_text(json.dumps(self.mock))
        result = self.invoke(*self.attach_args(), env=self.attach_env("wA:p2"))
        self.assertEqual(result.returncode, 78)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / "detached-fallback").exists())
        self.wait_attachment_bridge(bridge)

    def test_attachment_unsigned_or_foreign_receipt_never_reaches_inspection(self):
        self.allocation = self.prepare_profile()
        receipt = pathlib.Path(self.allocation["receipt"])
        signed = json.loads(receipt.read_text())
        signed["value"]["task"] = "private-marker"
        receipt.write_text(json.dumps(signed))
        result = self.invoke("--repo-qa", "attach-check", "attach", str(receipt), "--pid", "123", "--port", "9222", "snapshot")
        self.assertEqual(result.returncode, 78)
        self.assertIn("provenance", result.stderr)
        self.assertNotIn("private-marker", result.stdout + result.stderr)
        self.rewrite_signed_receipt(lambda value: value.update(task="attach-check", uid=os.getuid() + 1))
        result = self.invoke("--repo-qa", "attach-check", "attach", str(receipt), "--pid", "123", "--port", "9222", "snapshot")
        self.assertEqual(result.returncode, 78)
        self.assertIn("UID", result.stderr)

    def install_fake_packages(self, axi_version="0.1.35", mcp_version="1.6.0"):
        axi_dir = self.home / ".npm-global/lib/node_modules/chrome-devtools-axi"
        mcp_dir = self.home / ".npm-global/lib/node_modules/chrome-devtools-mcp"
        (axi_dir / "dist/bin").mkdir(parents=True)
        (mcp_dir / "build/src/bin").mkdir(parents=True)
        (axi_dir / "dist/bin/chrome-devtools-axi.js").write_text("")
        (axi_dir / "package.json").write_text(
            json.dumps({"name": "chrome-devtools-axi", "version": axi_version})
        )
        (mcp_dir / "package.json").write_text(
            json.dumps({"name": "chrome-devtools-mcp", "version": mcp_version})
        )

    def stop_test_owned_process(self, process):
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)

    def session_name(self, task):
        repo_hash = hashlib.sha256(str(self.repo.resolve()).encode()).hexdigest()[:12]
        return f"qa-{repo_hash}-{task}"

    def session_state_dir(self, task):
        return self.home / ".chrome-devtools-axi/sessions" / self.session_name(task)

    def session_port(self, task):
        value = 2166136261
        for character in self.session_name(task):
            value = ((value ^ ord(character)) * 16777619) & 0xFFFFFFFF
        if value >= 0x80000000:
            value -= 0x100000000
        return 9225 + abs(value) % 1000

    def invoke(self, *args, cwd=None, env=None):
        if (
            len(args) >= 3
            and args[0] == "--repo-qa"
            and args[1] == getattr(self, "attachment_task", None)
            and args[2] == "attach"
        ):
            self.release_attachment_port_reservation()
        return subprocess.run(
            [str(LAUNCHER), *args],
            cwd=cwd or self.repo,
            env=env or self.env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_session_start_is_inert_and_shows_qa_routing(self):
        state_dir = self.home / ".chrome-devtools-axi"
        state_dir.mkdir()
        sentinel = state_dir / "bridge.pid"
        sentinel.write_text("private-default-session-marker")

        result = self.invoke(cwd=self.home)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--repo-qa <task-name>", result.stdout)
        self.assertNotIn(
            "private-default-session-marker", result.stdout + result.stderr
        )
        self.assertEqual(sentinel.read_text(), "private-default-session-marker")

    def test_help_and_version_are_launch_free(self):
        help_result = self.invoke("--help", cwd=self.home)
        version_result = self.invoke("--version", cwd=self.home)

        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("Attached Axi commands use the pinned local", help_result.stdout)
        self.assertIn("start and setup remain disabled", help_result.stdout)
        self.assertIn("not an", help_result.stdout)
        self.assertIn("egress firewall", help_result.stdout)
        self.assertIn("Repeat --target", help_result.stdout)
        self.assertEqual(version_result.returncode, 0, version_result.stderr)
        self.assertIn("0.1.35", version_result.stdout)
        self.assertFalse((self.home / ".chrome-devtools-axi").exists())

    def test_help_explains_metadata_free_diagnosis_and_scope_independent_stop(self):
        result = self.invoke("--help", cwd=self.home)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("diagnose", result.stdout)
        self.assertIn("categorical", result.stdout)
        self.assertRegex(result.stdout, r"not (?:cleanup or )?proof readiness")
        self.assertIn("No owned bridge", result.stdout)
        self.assertIn("independent of target", result.stdout)
        self.assertIn("Permission-denied and mixed-UID entries stay UNKNOWN", result.stdout)
        self.assertIn("primary/reprobe observations and may overlap", result.stdout)

    def test_browser_commands_require_explicit_repository_qa_intent(self):
        self.install_fake_packages()
        result = self.invoke("snapshot")

        self.assertEqual(result.returncode, 78)
        self.assertIn("explicit repository QA intent is required", result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / ".chrome-devtools-axi").exists())

    def test_invalid_task_commands_and_non_repository_cwd_fail_closed(self):
        self.install_fake_packages()
        cases = [
            (("--repo-qa", "../default", "prepare-profile"), self.repo),
            (("--repo-qa", "arena-crm", "setup"), self.repo),
            (("--repo-qa", "arena-crm", "prepare-profile"), self.home),
        ]

        for args, cwd in cases:
            with self.subTest(args=args, cwd=cwd):
                result = self.invoke(*args, cwd=cwd)
                self.assertEqual(result.returncode, 78)

        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / ".chrome-devtools-axi").exists())

    def test_transport_and_profile_overrides_fail_before_backend_and_are_not_echoed(
        self,
    ):
        self.install_fake_packages()
        secret = "qa-secret-that-must-not-be-printed"
        unsafe_names = [
            "CHROME_DEVTOOLS_AXI_BROWSER_URL",
            "CHROME_DEVTOOLS_AXI_USER_DATA_DIR",
            "CHROME_DEVTOOLS_AXI_WS_ENDPOINT",
            "CHROME_DEVTOOLS_AXI_MCP_PATH",
            "CHROME_DEVTOOLS_AXI_UNRECOGNIZED_CONTROL",
            "CHROME_DEVTOOLS_MCP_SESSION_ID",
            "PUPPETEER_EXECUTABLE_PATH",
            "DEBUG",
        ]

        for name in unsafe_names:
            with self.subTest(name=name):
                env = self.env.copy()
                env[name] = secret
                result = self.invoke(
                    "--repo-qa", "arena-crm", "prepare-profile", env=env
                )
                self.assertEqual(result.returncode, 78)
                self.assertNotIn(secret, result.stdout + result.stderr)
                self.assertIn("overrides are set", result.stderr)

        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / ".chrome-devtools-axi").exists())

    def test_cleanup_requires_current_herdr_caller_before_retirement(self):
        self.install_attachment_fixture()
        self.mock["browser_gone"] = True
        self.mock["profile_users"] = []
        self.mock_path.write_text(json.dumps(self.mock))
        receipt = pathlib.Path(self.allocation["receipt"])
        before = receipt.read_bytes()
        profile = pathlib.Path(self.allocation["profile"])
        missing_context = self.env.copy()
        for key in tuple(missing_context):
            if key.startswith("HERDR_"):
                missing_context.pop(key)
        cases = [missing_context, self.attach_env("wForeign:p1")]
        for env in cases:
            with self.subTest(caller=env.get("HERDR_PANE_ID", "absent")):
                result = self.invoke(*self.attach_args("cleanup"), env=env)
                self.assertEqual(result.returncode, 78, result.stdout + result.stderr)
                self.assertTrue(profile.exists())
                self.assertEqual(receipt.read_bytes(), before)
        result = self.invoke(*self.attach_args("cleanup"), env=self.attach_env())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(profile.exists())

    def test_attachment_requires_explicit_live_herdr_binding(self):
        self.install_attachment_fixture()

        result = self.invoke(*self.attach_args("snapshot"))

        self.assertEqual(result.returncode, 78)
        self.assertIn("live Herdr caller context", result.stderr)
        self.assertFalse((self.home / "backend-calls.jsonl").exists())
        self.assertFalse((self.home / "detached-fallback").exists())


    def test_cli_transport_and_profile_flags_are_rejected(self):
        unsafe_flags = [
            "--browserUrl=http://127.0.0.1:9222",
            "--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/x",
            "--user-data-dir=/tmp/profile",
            "--autoConnect",
            "--server-url=http://localhost:3000",
            "--executablePath=/Applications/Zen.app",
            "--channel=canary",
            "--headless",
            "--chromeArgs=--no-sandbox",
            "--remote-debugging-port=9222",
            "--chrome-arg=--remote-debugging-port=9222",
        ]

        for flag in unsafe_flags:
            with self.subTest(flag=flag):
                result = self.invoke(
                    "--repo-qa", "arena-crm", "attach", "/missing/receipt",
                    "--pid", "123", "--port", "9222", "snapshot", flag,
                )
                self.assertEqual(result.returncode, 78)
                self.assertIn(
                    "transport and profile flags are not supported", result.stderr
                )
                self.assertNotIn("/missing/receipt", result.stdout + result.stderr)

        self.assertFalse((self.home / "backend-calls.jsonl").exists())

    def test_pinned_backend_versions_fail_closed(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        packages = [
            (
                self.home / ".npm-global/lib/node_modules/chrome-devtools-axi/package.json",
                "0.1.36",
                "0.1.35",
                "pinned local chrome-devtools-axi version is not 0.1.35",
            ),
            (
                self.home / ".npm-global/lib/node_modules/chrome-devtools-mcp/package.json",
                "1.6.1",
                "1.6.0",
                "pinned local chrome-devtools-mcp version is not 1.6.0",
            ),
        ]
        try:
            for package, version, pinned, message in packages:
                metadata = json.loads(package.read_text())
                metadata["version"] = version
                package.write_text(json.dumps(metadata))
                result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))
                self.assertEqual(result.returncode, 78)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.home / "backend-calls.jsonl").exists())
                metadata["version"] = pinned
                package.write_text(json.dumps(metadata))
        finally:
            if bridge.poll() is None:
                bridge.terminate()
            self.wait_attachment_bridge(bridge)

    def test_writable_package_ancestor_fails_closed(self):
        self.install_attachment_fixture()
        bridge = self.start_attachment_bridge()
        node_modules = self.home / ".npm-global/lib/node_modules"
        os.chmod(node_modules, 0o777)
        try:
            result = self.invoke(*self.attach_args("snapshot"), env=self.attach_env("wA:p2"))
            self.assertEqual(result.returncode, 78)
            self.assertIn("package directory is unsafe", result.stderr)
            self.assertFalse((self.home / "backend-calls.jsonl").exists())
        finally:
            os.chmod(node_modules, 0o755)
            if bridge.poll() is None:
                bridge.terminate()
            self.wait_attachment_bridge(bridge)


if __name__ == "__main__":
    unittest.main()
