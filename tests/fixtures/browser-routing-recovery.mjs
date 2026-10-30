import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  prepareNative,
  confirmNative,
  startRoute,
  attachRoute,
  bindRoute,
  focusRoute,
  stopRoute,
  connect,
} from "../../home/.agents/skills/browser-routing/scripts/qa-route.mjs";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run the bounded native browser proof");
const sourceHash = createHash("sha256")
  .update(
    readFileSync(
      new URL("../../home/.agents/skills/browser-routing/scripts/qa-route.mjs", import.meta.url),
    ),
  )
  .digest("hex");
const dir = mkdtempSync(join(realpathSync(tmpdir()), "qa-route-proof-"));
const server = createServer((req, res) => {
  const label = new URL(req.url, "http://localhost").pathname.slice(1).replace(/[^a-z-]/g, "");
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    `<!doctype html><title>QA routing fixture</title><body style="font:24px system-ui;padding:40px"><h1>Browser routing proof: ${label}</h1><p>Fabricated local fixture</p><button onclick="document.querySelector('output').textContent=Number(document.querySelector('output').textContent)+1">Increment ${label}</button> <output>0</output></body>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const a = join(dir, "a.json"),
  b = join(dir, "b.json"),
  c = join(dir, "c.json");
const receipts = [];
const deadline = Date.now() + 600000;
async function gate(file) {
  while (!existsSync(join(dir, file))) {
    if (Date.now() > deadline) throw new Error("Live proof deadline reached");
    await new Promise((r) => setTimeout(r, 200));
  }
}
let browserA;
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
try {
  const before = JSON.parse(
    execFileSync(
      "aerospace",
      ["list-windows", "--all", "--json", "--format", "%{window-id}%{app-pid}%{workspace}"],
      { encoding: "utf8" },
    ),
  );
  writeFileSync(join(dir, "baseline.json"), JSON.stringify(before));
  await startRoute(a, "routing-proof-a", await freePort(), base + "/alpha");
  await startRoute(b, "routing-proof-b", await freePort(), base + "/beta");
  const sa = JSON.parse(readFileSync(a));
  browserA = await connect(sa.browserSocket);
  const decoy = await browserA.send("Target.createTarget", { url: base + "/decoy" });
  const third = await browserA.send("Target.createTarget", {
    url: base + "/gamma",
    newWindow: true,
  });
  await new Promise((r) => setTimeout(r, 500));
  await attachRoute(c, "routing-proof-c", sa.pid, sa.port, sa.profile, "live-proof parent a.json");
  await bindRoute(c, "routing-proof-c", third.targetId, base + "/gamma");
  // A challenged title must be restored on its original tab before a deliberate rebind.
  await prepareNative(a, "routing-proof-a");
  await bindRoute(a, "routing-proof-a", decoy.targetId, base + "/decoy");
  const pages = await (await fetch(`http://127.0.0.1:${sa.port}/json/list`)).json();
  const alpha = pages.find((p) => p.id === sa.targetId);
  const alphaPage = await connect(alpha.webSocketDebuggerUrl);
  try {
    const { result } = await alphaPage.send("Runtime.evaluate", {
      expression: "document.title",
      returnByValue: true,
    });
    if (result.value !== "QA routing fixture")
      throw new Error("Rebind left native challenge on old tab");
  } finally {
    alphaPage.close();
  }
  await bindRoute(a, "routing-proof-a", sa.targetId, base + "/alpha");
  await prepareNative(a, "routing-proof-a");
  let wrongNativeRejected = false;
  try {
    await confirmNative(a, "routing-proof-a", "QA routing fixture");
  } catch (e) {
    wrongNativeRejected = /different window/.test(e.message);
  }
  if (!wrongNativeRejected) throw new Error("Wrong native observation was accepted");
  receipts.push({ rebindRestoredOriginalTitle: true, wrongNativeObservationRejected: true });
  // Stale identities must fail before native interaction or target substitution.
  for (const [field, value, reason] of [
    ["birth", "stale-birth", "birth identity"],
    ["profileIdentity", "stale-profile", "profile identity"],
    ["browserSocket", "ws://127.0.0.1:" + sa.port + "/devtools/browser/stale", "generation"],
  ]) {
    const stale = join(dir, "stale-" + field + ".json");
    writeFileSync(stale, JSON.stringify({ ...sa, [field]: value }), { mode: 0o600 });
    let failed = false;
    try {
      await focusRoute(stale, "routing-proof-a");
    } catch (e) {
      failed = e.message.includes(reason);
    }
    if (!failed) throw new Error("Stale identity accepted: " + field);
    receipts.push({ rejectedStale: field });
  }
  await focusRoute(b, "routing-proof-b");
  writeFileSync(
    join(dir, "ready.json"),
    JSON.stringify({ dir, a, b, c, base, decoy: decoy.targetId }),
  );
  console.log(
    JSON.stringify({
      stage: "ready",
      dir,
      states: { a, b, c },
      base,
      windowCount: 3,
      processCount: 2,
    }),
  );
  if (process.argv.includes("--auto")) writeFileSync(join(dir, "continue.request"), "auto\n");
  await gate("continue.request");
  for (let i = 0; i < 10; i++) {
    console.log(JSON.stringify({ stage: "cycle", index: i }));
    receipts.push(await focusRoute(c, "routing-proof-c"));
    writeFileSync(join(dir, "partial-receipt.json"), JSON.stringify(receipts, null, 2));
    receipts.push(await focusRoute(b, "routing-proof-b"));
    writeFileSync(join(dir, "partial-receipt.json"), JSON.stringify(receipts, null, 2));
    await browserA.send("Target.activateTarget", { targetId: decoy.targetId });
    const sa2 = JSON.parse(readFileSync(a));
    execFileSync("aerospace", [
      "move-node-to-workspace",
      "--window-id",
      String(sa2.nativeWindowId),
      "qa-route-displaced",
    ]);
    receipts.push(await focusRoute(a, "routing-proof-a"));
    writeFileSync(join(dir, "partial-receipt.json"), JSON.stringify(receipts, null, 2));
  }
  // Closed target must stop recovery, preserving the other windows.
  await browserA.send("Target.closeTarget", { targetId: third.targetId });
  let rejected = false;
  try {
    await focusRoute(c, "routing-proof-c");
  } catch (e) {
    rejected = /Saved tab is gone/.test(e.message);
  }
  if (!rejected) throw new Error("Closed tab did not fail closed");
  receipts.push({ closedTargetRejected: true });
  writeFileSync(join(dir, "receipt.json"), JSON.stringify({ sourceHash, receipts }, null, 2));
  console.log(
    JSON.stringify({ stage: "cycles-passed", recoveries: 30, closedTargetRejected: true, dir }),
  );
  if (process.argv.includes("--auto")) writeFileSync(join(dir, "stop.request"), "auto\n");
  await gate("stop.request");
} catch (e) {
  console.error(e.stack);
  process.exitCode = 1;
} finally {
  browserA?.close();
  for (const [state, task] of [
    [a, "routing-proof-a"],
    [b, "routing-proof-b"],
  ]) {
    if (existsSync(state)) {
      try {
        console.log(JSON.stringify({ task, ...(await stopRoute(state, task)) }));
      } catch (e) {
        console.error("Cleanup blocked: " + e.message);
        process.exitCode = 1;
      }
    }
  }
  const ownPids = [a, b].filter(existsSync).map((f) => JSON.parse(readFileSync(f)).pid);
  // AeroSpace can briefly retain exited windows after kernel process/port shutdown.
  // Re-probe instead of accepting a stale view as either cleanup success or failure.
  let after;
  for (let attempt = 0; attempt < 50; attempt++) {
    after = JSON.parse(
      execFileSync(
        "aerospace",
        ["list-windows", "--all", "--json", "--format", "%{window-id}%{app-pid}%{workspace}"],
        { encoding: "utf8" },
      ),
    );
    if (!after.some((x) => ownPids.includes(x["app-pid"]))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const before = JSON.parse(readFileSync(join(dir, "baseline.json")));
  const preserved = before.every((row) =>
    after.some(
      (x) =>
        x["window-id"] === row["window-id"] &&
        x["app-pid"] === row["app-pid"] &&
        x.workspace === row.workspace,
    ),
  );

  const noSurvivors = !after.some((x) => ownPids.includes(x["app-pid"]));
  writeFileSync(join(dir, "cleanup.json"), JSON.stringify({ preserved, noSurvivors }, null, 2));
  console.log(JSON.stringify({ stage: "cleanup", preserved, noSurvivors, dir }));
  if (!preserved || !noSurvivors) process.exitCode = 1;
  server.close();
}
