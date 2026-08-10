import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ensureKernelPython } from "./bootstrap.js";

test("managed bootstrap aborts a running uv process and releases its lock", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-bootstrap-test-"));
  const bin = join(directory, "bin");
  const venv = join(directory, "venv");
  const started = join(directory, "uv-started");
  const oldPath = process.env.PATH;
  const oldVenv = process.env.PI_IPYTHON_VENV;
  const oldPython = process.env.PI_IPYTHON_PYTHON;

  try {
    delete process.env.PI_IPYTHON_PYTHON;
    mkdirSync(bin);
    const uv = join(bin, "uv");
    writeFileSync(uv, `#!/bin/sh\nprintf started > ${JSON.stringify(started)}\nexec /bin/sleep 30\n`);
    chmodSync(uv, 0o755);
    process.env.PATH = `${bin}${delimiter}${oldPath ?? ""}`;
    process.env.PI_IPYTHON_VENV = venv;

    const controller = new AbortController();
    const setup = ensureKernelPython({ signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (!existsSync(started) && Date.now() < deadline) await sleep(20);
    assert.equal(existsSync(started), true, "fake uv did not start");

    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(setup, /IPython setup aborted/);
    assert.ok(Date.now() - abortedAt < 2_000, "bootstrap cancellation was not prompt");
    assert.equal(existsSync(`${venv}.bootstrap.lock`), false);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldVenv === undefined) delete process.env.PI_IPYTHON_VENV;
    else process.env.PI_IPYTHON_VENV = oldVenv;
    if (oldPython === undefined) delete process.env.PI_IPYTHON_PYTHON;
    else process.env.PI_IPYTHON_PYTHON = oldPython;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("interpreter verification is cancelled promptly", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-ipython-verify-test-"));
  const python = join(directory, "python");
  const started = join(directory, "python-started");
  const oldPython = process.env.PI_IPYTHON_PYTHON;

  try {
    writeFileSync(python, `#!/bin/sh\nprintf started > ${JSON.stringify(started)}\nexec /bin/sleep 30\n`);
    chmodSync(python, 0o755);
    process.env.PI_IPYTHON_PYTHON = python;

    const controller = new AbortController();
    const setup = ensureKernelPython({ signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (!existsSync(started) && Date.now() < deadline) await sleep(20);
    assert.equal(existsSync(started), true, "fake interpreter did not start");

    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(setup, /IPython setup aborted/);
    assert.ok(Date.now() - abortedAt < 2_000, "interpreter verification cancellation was not prompt");
  } finally {
    if (oldPython === undefined) delete process.env.PI_IPYTHON_PYTHON;
    else process.env.PI_IPYTHON_PYTHON = oldPython;
    rmSync(directory, { recursive: true, force: true });
  }
});
