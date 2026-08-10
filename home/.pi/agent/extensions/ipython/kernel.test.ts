import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IpythonRuntime } from "./runtime.js";
import { buildSnapshotCode } from "./state-snapshot.js";

const primePython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
const managedPython = join(homedir(), ".pi", "agent", "ipython-venv", "bin", "python");
const python = process.env.TEST_IPYTHON_PYTHON
  ?? (existsSync(primePython) ? primePython : existsSync(managedPython) ? managedPython : undefined);

test("real IPython kernel persists, executes native shell cells, and restores snapshots", { timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-test-"));
  const snapshots = join(directory, "artifacts");
  let runtime = new IpythonRuntime({
    cwd: directory,
    sessionId: "kernel-test",
    python,
    snapshotDir: snapshots,
  });

  try {
    const first = await runtime.execute(`
answer = 41
persisted = {'value': answer}
shared = []
shared_alias = shared
raw_bytes = b'\\x80\\x04K*.'
def sees_live_globals():
    return shared is shared_alias and sees_live_globals.__globals__ is globals()
func_alias = sees_live_globals
funcs = [sees_live_globals]
class SnapshotReader:
    def sees_live_globals(self):
        return shared is shared_alias and self.sees_live_globals.__globals__ is globals()
    @property
    def live_property(self):
        return shared is shared_alias and SnapshotReader.live_property.fget.__globals__ is globals()
reader = SnapshotReader()
import functools
function_partial = functools.partial(sees_live_globals)
class CallbackHolder:
    pass
holder = CallbackHolder()
holder.callback = sees_live_globals
from collections import namedtuple
SnapshotPoint = namedtuple('SnapshotPoint', ['x', 'y'])
point = SnapshotPoint(20, 22)
class CyclicReader:
    def sees_live_globals(self):
        return shared is shared_alias and self.cycle[0] is self
cyclic_reader = CyclicReader()
cyclic_reader.cycle = (cyclic_reader,)
id = 123
vars = 'shadowed vars'
setattr = None
print('set')
`);
    assert.equal(first.status, "ok", first.error?.traceback.join("\n"));
    assert.equal(first.stdout.trim(), "set");

    const second = await runtime.execute("import asyncio\nawait asyncio.sleep(0.01)\nprint(answer + 1)");
    assert.equal(second.status, "ok", second.error?.traceback.join("\n"));
    assert.equal(second.stdout.trim(), "42");

    const shell = await runtime.execute("%%bash\nprintf 'native-shell'");
    assert.equal(shell.status, "ok", shell.error?.traceback.join("\n"));
    assert.equal(shell.stdout.trim(), "native-shell");

    const displayed = await runtime.execute(`
from IPython.display import display
display('visible display')
display({'image/png': 'AAAA', 'text/plain': 'image preview'}, raw=True)
21 * 2
`);
    assert.equal(displayed.status, "ok", displayed.error?.traceback.join("\n"));
    assert.match(displayed.display ?? "", /visible display/);
    assert.match(displayed.display ?? "", /image preview/);
    assert.deepEqual(displayed.attachments, [{ mimeType: "image/png", data: "AAAA" }]);
    assert.equal(displayed.result, "42");

    let completeExpressionResult = "";
    const largeExpression = await runtime.execute("'x' * 70000", {
      onRichOutput: (text, kind) => {
        if (kind === "result") completeExpressionResult = text;
      },
    });
    assert.match(largeExpression.result ?? "", /output truncated/);
    assert.ok(completeExpressionResult.length > 70_000);

    const names = await runtime.listNamespaceNames();
    assert.ok(names?.includes("answer"));
    assert.ok(names?.includes("persisted"));

    const failure = await runtime.execute("raise ValueError('expected failure')");
    assert.equal(failure.status, "error");
    assert.equal(failure.error?.ename, "ValueError");

    const cappedPayload = join(directory, "capped", "state.dill");
    const capAttempt = await runtime.execute(
      buildSnapshotCode(cappedPayload, join(directory, "capped", "state.json"), 64),
    );
    assert.equal(capAttempt.status, "ok", capAttempt.error?.traceback.join("\n"));
    assert.match(capAttempt.stdout, /serialized payload exceeds snapshot size cap/);
    assert.equal(existsSync(cappedPayload), false);

    await runtime.dispose();
    assert.equal(statSync(join(snapshots, "kernel-state.dill")).mode & 0o777, 0o600);
    assert.equal(statSync(join(snapshots, "kernel-state.json")).mode & 0o777, 0o600);
    assert.equal(statSync(snapshots).mode & 0o777, 0o700);
    runtime = new IpythonRuntime({
      cwd: directory,
      sessionId: "kernel-test-resumed",
      python,
      snapshotDir: snapshots,
    });
    await runtime.ensure();
    const restore = runtime.consumeRestore();
    assert.ok(restore?.restored.includes("answer"));
    assert.ok(restore?.restored.includes("persisted"));

    const resumed = await runtime.execute(`
print(persisted['value'] + 1)
print(shared is shared_alias)
print(sees_live_globals())
print(SnapshotReader().sees_live_globals())
print(SnapshotReader().live_property)
print(func_alias is sees_live_globals and funcs[0] is sees_live_globals and funcs[0]())
print(function_partial.func is sees_live_globals and function_partial())
print(holder.callback is sees_live_globals and holder.callback())
print(raw_bytes == b'\\x80\\x04K*.')
print(isinstance(point, SnapshotPoint) and point.x + point.y == 42)
print(cyclic_reader.cycle[0] is cyclic_reader and cyclic_reader.sees_live_globals())
print(id == 123 and vars == 'shadowed vars' and setattr is None)
`);
    assert.equal(resumed.status, "ok", resumed.error?.traceback.join("\n"));
    assert.equal(resumed.stdout.trim(), "42\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue\nTrue");
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("aborting a cell interrupts it and a reset produces a fresh namespace", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-abort-test-"));
  const runtime = new IpythonRuntime({ cwd: directory, sessionId: "abort-test", python });
  try {
    const controller = new AbortController();
    const execution = runtime.execute("while True:\n    pass", { signal: controller.signal });
    setTimeout(() => controller.abort(), 200);
    const result = await execution;
    assert.equal(result.status, "aborted");

    await runtime.reset();
    const fresh = await runtime.execute("print('answer' in globals())");
    assert.equal(fresh.status, "ok", fresh.error?.traceback.join("\n"));
    assert.equal(fresh.stdout.trim(), "False");
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late stream output after a forced abort does not poison the kernel", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-late-output-test-"));
  const runtime = new IpythonRuntime({ cwd: directory, sessionId: "late-output-test", python });
  try {
    await runtime.ensure();
    const controller = new AbortController();
    let descriptorOpen = true;
    let sawLateOutput = false;
    const execution = runtime.execute(`
import time
try:
    time.sleep(10)
except KeyboardInterrupt:
    time.sleep(1.3)
    print('late-after-abort')
`, {
      signal: controller.signal,
      onStream: () => {
        if (!descriptorOpen) sawLateOutput = true;
      },
    });
    setTimeout(() => controller.abort(), 200);
    const result = await execution;
    assert.equal(result.status, "aborted");
    descriptorOpen = false;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(sawLateOutput, true);

    const next = await runtime.execute("print('kernel-healthy')");
    assert.equal(next.status, "ok", next.error?.traceback.join("\n"));
    assert.equal(next.stdout.trim(), "kernel-healthy");
  } finally {
    await runtime.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
