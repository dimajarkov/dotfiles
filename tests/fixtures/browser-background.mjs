import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  startRoute,
  stopRoute,
  readRoute,
  connect,
  bindBackground,
  focusRoute,
} from "../../home/.agents/skills/browser-routing/scripts/qa-route.mjs";
import {
  backgroundCommand,
  metrics,
} from "../../home/.agents/skills/browser-routing/scripts/background.mjs";
const run = (args) => execFileSync("aerospace", args, { encoding: "utf8" }).trim();
const inventory = () =>
  JSON.parse(
    run([
      "list-windows",
      "--all",
      "--json",
      "--format",
      "%{window-id}%{app-pid}%{workspace}%{window-layout}%{window-is-fullscreen}",
    ]),
  );
const focused = () =>
  JSON.parse(
    run(["list-windows", "--focused", "--json", "--format", "%{window-id}%{app-pid}%{workspace}"]),
  );
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run the bounded isolated browser proof");
const sourceHashes = Object.fromEntries(
  ["qa-route.mjs", "background.mjs"].map((name) => [
    name,
    createHash("sha256")
      .update(
        readFileSync(
          new URL("../../home/.agents/skills/browser-routing/scripts/" + name, import.meta.url),
        ),
      )
      .digest("hex"),
  ]),
);
const directory = mkdtempSync(join(realpathSync(tmpdir()), "browser-background-proof-"));
const route = join(directory, "route.json"),
  sentinel = join(directory, "sentinel.json");
const secret = randomBytes(24).toString("hex");
const server = createServer((req, res) => {
  if (req.url === "/login") {
    res.writeHead(302, {
      "Set-Cookie": `fixture=${secret}; HttpOnly; SameSite=Strict; Path=/`,
      Location: "/fixture",
    });
    res.end();
    return;
  }
  const authenticated = req.headers.cookie === `fixture=${secret}`;
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Background routing fixture</title><style>body{font:24px system-ui;padding:30px}#narrow{display:none}@media(max-width:650px){#narrow{display:block}}</style><h1>Isolated background fixture</h1><p id="auth">${authenticated ? "Authenticated synthetic fixture" : "Signed out synthetic fixture"}</p><p id="narrow">Narrow viewport</p>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
const receipts = [];
const before = inventory();
let cdp, pc;
try {
  await startRoute(route, "background-fixture", await freePort(), base + "/fixture");

  const s = readRoute(route);
  cdp = await connect(s.browserSocket);
  const target = (await (await fetch(`http://127.0.0.1:${s.port}/json/list`)).json()).find(
    (t) => t.id === s.targetId,
  );
  pc = await connect(target.webSocketDebuggerUrl);
  // RED: repeat the ineffective native content resize while AeroSpace manages this window.
  run(["fullscreen", "on", "--window-id", String(s.nativeWindowId)]);
  const original = await metrics(pc);
  const layout = inventory().find((w) => w["window-id"] === s.nativeWindowId);
  await cdp.send("Browser.setWindowBounds", {
    windowId: s.cdpWindowId,
    bounds: { width: 600, height: 843 },
  });
  await wait(600);
  const ignored = await metrics(pc);
  if (ignored.width === 600 && ignored.height === 700)
    throw new Error("Visible tiled resize did not reproduce the expected no-op");
  receipts.push({
    baselineResize: {
      original,
      layout,
      actual: ignored,
      requestApplied: ignored.width === 600 && ignored.height === 700,
    },
  });
  console.log(JSON.stringify({ stage: "visible-baseline", original, actual: ignored, layout }));
  // Restore helper-owned normal fullscreen options to the exact baseline before corrected path.
  run(["fullscreen", "off", "--window-id", String(s.nativeWindowId)]);
  run(["fullscreen", "on", "--window-id", String(s.nativeWindowId)]);
  await wait(300);
  const directBefore = await metrics(pc);
  await cdp.send("Browser.setContentsSize", { windowId: s.cdpWindowId, width: 650, height: 730 });
  await wait(600);
  const directAfter = await metrics(pc);
  receipts.push({ visibleContentsSize: { before: directBefore, after: directAfter } });
  console.log(
    JSON.stringify({ stage: "visible-contents-size", before: directBefore, after: directAfter }),
  );
  run(["fullscreen", "off", "--window-id", String(s.nativeWindowId)]);
  run(["fullscreen", "on", "--window-id", String(s.nativeWindowId)]);
  await wait(300);
  const decoy = await cdp.send("Target.createTarget", { url: base + "/decoy" });
  await startRoute(sentinel, "background-sentinel", await freePort(), base + "/sentinel");
  const active = focused();
  const originalNativeBounds = await cdp.send("Browser.getWindowBounds", {
    windowId: s.cdpWindowId,
  });
  await bindBackground(route, "background-fixture", s.targetId, base + "/fixture");
  const assertFocus = (label) => {
    if (JSON.stringify(focused()) !== JSON.stringify(active))
      throw new Error("Foreground changed during " + label);
  };
  assertFocus("background bind");
  await pc.send("Page.navigate", { url: base + "/login" });
  for (let i = 0; i < 30; i++) {
    const r = await pc.send("Runtime.evaluate", {
      expression: 'location.pathname==="/fixture"&&document.getElementById("auth")?.textContent',
      returnByValue: true,
    });
    if (r.result.value === "Authenticated synthetic fixture") break;
    if (i === 29) throw new Error("Synthetic background auth failed");
    await wait(100);
  }
  assertFocus("synthetic transport login");
  receipts.push({
    backgroundAuthentication: true,
    proofScope: "synthetic browser transport; not an Arena identity assertion",
  });
  receipts.push(await backgroundCommand("diagnostics", route, "background-fixture", {}));
  assertFocus("diagnostics");
  receipts.push(
    await backgroundCommand("screenshot", route, "background-fixture", {
      "--path": join(directory, "background-wide.png"),
    }),
  );
  assertFocus("screenshot");
  receipts.push(
    await backgroundCommand("viewport", route, "background-fixture", {
      "--width": "600",
      "--height": "700",
    }),
  );
  assertFocus("viewport");
  const narrow = await backgroundCommand("screenshot", route, "background-fixture", {
    "--path": join(directory, "background-narrow.png"),
  });
  if (
    narrow.metrics.width !== 600 ||
    narrow.metrics.height !== 700 ||
    narrow.afterMetrics.width !== 600 ||
    narrow.afterMetrics.height !== 700
  )
    throw new Error("Separate-connection screenshot lost viewport policy");
  const png = readFileSync(narrow.path);
  if (
    png.readUInt32BE(16) !== 600 * narrow.metrics.dpr ||
    png.readUInt32BE(20) !== 700 * narrow.metrics.dpr
  )
    throw new Error("Narrow PNG pixel dimensions mismatch");
  receipts.push(narrow);
  assertFocus("narrow screenshot");
  receipts.push(await backgroundCommand("viewport-reset", route, "background-fixture", {}));
  assertFocus("viewport reset");
  if (
    JSON.stringify(await cdp.send("Browser.getWindowBounds", { windowId: s.cdpWindowId })) !==
    JSON.stringify(originalNativeBounds)
  )
    throw new Error("Background viewport/capture changed native bounds");
  receipts.push({ backgroundNativeBoundsPreserved: true });
  let inactiveResizeRejected = false;
  try {
    await backgroundCommand("window-resize", route, "background-fixture", {
      "--width": "600",
      "--height": "700",
    });
  } catch (error) {
    inactiveResizeRejected = /selected visible tab/.test(error.message);
  }
  if (!inactiveResizeRejected || readRoute(route).resizeOriginal)
    throw new Error("Inactive native resize was not rejected before mutation");
  assertFocus("inactive native resize rejection");
  receipts.push({ inactiveNativeResizeRejected: true });
  // Confirm physical resizing also survives while the owned workspace is visible.
  await focusRoute(route, "background-fixture");
  receipts.push(
    await backgroundCommand("window-resize", route, "background-fixture", {
      "--width": "620",
      "--height": "710",
    }),
  );
  receipts.push(await backgroundCommand("window-restore", route, "background-fixture", {}));
  writeFileSync(
    join(directory, "receipt.json"),
    JSON.stringify(
      {
        sourceHashes,
        active,
        receipts,
        decoyTargetPreserved: (
          await (await fetch(`http://127.0.0.1:${s.port}/json/list`)).json()
        ).some((t) => t.id === decoy.targetId),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      directory,
      passed: true,
      foregroundUnchanged: true,
      receipts: receipts.length,
    }),
  );
} catch (e) {
  writeFileSync(
    join(directory, "failure.json"),
    JSON.stringify({ error: e.stack, receipts }, null, 2),
  );
  console.error(e.stack);
  console.log(JSON.stringify({ directory, passed: false }));
  process.exitCode = 1;
} finally {
  pc?.close();
  cdp?.close();
  for (const [f, t] of [
    [route, "background-fixture"],
    [sentinel, "background-sentinel"],
  ])
    if (existsSync(f)) {
      try {
        await stopRoute(f, t);
      } catch (e) {
        console.error("Cleanup: " + e.message);
        process.exitCode = 1;
      }
    }
  const pids = [route, sentinel].filter(existsSync).map((f) => JSON.parse(readFileSync(f)).pid);
  let after;
  for (let i = 0; i < 50; i++) {
    after = inventory();
    if (!after.some((w) => pids.includes(w["app-pid"]))) break;
    await wait(100);
  }
  const preserved = before.every((w) =>
    after.some(
      (a) =>
        a["window-id"] === w["window-id"] &&
        a["app-pid"] === w["app-pid"] &&
        a.workspace === w.workspace,
    ),
  );
  const zeroSurvivors = !after.some((w) => pids.includes(w["app-pid"]));
  writeFileSync(join(directory, "cleanup.json"), JSON.stringify({ preserved, zeroSurvivors }));
  console.log(JSON.stringify({ cleanup: { preserved, zeroSurvivors }, directory }));
  if (!preserved || !zeroSurvivors) process.exitCode = 1;
  server.close();
}
