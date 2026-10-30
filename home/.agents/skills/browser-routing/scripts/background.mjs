import { execFileSync } from "node:child_process";
import { writeFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withOwnedPage, writeRoute, verifyProcess } from "./qa-route.mjs";
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (args) =>
  execFileSync("aerospace", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  }).trim();
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};
export function dimensions(width, height) {
  width = Number(width);
  height = Number(height);
  check(
    Number.isInteger(width) &&
      Number.isInteger(height) &&
      width >= 320 &&
      width <= 4096 &&
      height >= 240 &&
      height <= 4096,
    "Dimensions must be integer CSS pixels: width 320..4096, height 240..4096",
  );
  return { width, height };
}
export async function metrics(client) {
  const { result, exceptionDetails } = await client.send("Runtime.evaluate", {
    expression:
      "({width:innerWidth,height:innerHeight,outerWidth,outerHeight,x:screenX,y:screenY,dpr:devicePixelRatio,scale:visualViewport?.scale,zoom:getComputedStyle(document.documentElement).zoom,readyState:document.readyState,focused:document.hasFocus(),visibility:document.visibilityState})",
    returnByValue: true,
  });
  check(!exceptionDetails && result.value, "Unable to observe page metrics");
  return result.value;
}
async function waitMetrics(client, width, height) {
  let actual;
  for (let i = 0; i < 30; i++) {
    actual = await metrics(client);
    if (actual.width === width && actual.height === height) return actual;
    await pause(100);
  }
  throw new Error(
    `Browser did not apply requested CSS viewport ${width}x${height}; actual ${actual?.width}x${actual?.height}`,
  );
}
export function resizePolicy(state, rows) {
  check(
    Number.isSafeInteger(state.nativeWindowId),
    "Native resize requires an explicitly mapped native window",
  );
  const owned = rows.filter(
    (r) =>
      r["window-id"] === state.nativeWindowId &&
      r["app-pid"] === state.pid &&
      r.workspace === state.workspace,
  );
  check(owned.length === 1, "Native window ownership/workspace changed");
  check(
    rows.filter((r) => r.workspace === state.workspace).length === 1,
    "Native resize would reflow a shared workspace; use target-only viewport instead",
  );
  return owned[0];
}
function layoutRows() {
  return JSON.parse(
    run([
      "list-windows",
      "--all",
      "--json",
      "--format",
      "%{window-id}%{app-pid}%{workspace}%{monitor-id}%{window-layout}%{window-is-fullscreen}",
    ]),
  );
}
async function windowResize(statePath, task, requested, restore) {
  return withOwnedPage(statePath, task, async ({ state: s, client, browserCDP }) => {
    check(!s.viewportPolicy, "Reset renderer viewport before native window resize");
    const row = resizePolicy(s, layoutRows());
    const win = await browserCDP.send("Browser.getWindowForTarget", { targetId: s.targetId });
    check(win.windowId === s.cdpWindowId, "CDP window identity changed");
    if (!restore) {
      check(
        (await metrics(client)).visibility === "visible",
        "Native resize needs the selected visible tab; use background viewport capture for an inactive tab",
      );
      check(!s.resizeOriginal, "Restore the previous native resize before starting another");
      check(
        win.bounds.windowState === "normal",
        "Native macOS fullscreen/minimized/maximized is not supported for reversible resize",
      );
      // Fullscreen gap mode cannot be inferred from its Boolean. Record the actual
      // baseline geometry and require exact restoration rather than claiming it.
      const original = { row, bounds: win.bounds, metrics: await metrics(client) };
      writeRoute(statePath, { ...s, resizeOriginal: original });
      try {
        for (const args of [
          ["fullscreen", "off", "--window-id", String(s.nativeWindowId)],
          ["layout", "--window-id", String(s.nativeWindowId), "floating"],
        ]) {
          verifyProcess(s);
          resizePolicy(s, layoutRows());
          run(args);
        }
        await browserCDP.send("Browser.setContentsSize", {
          windowId: win.windowId,
          width: requested.width,
          height: requested.height,
        });
        const actual = await waitMetrics(client, requested.width, requested.height);
        check(
          resizePolicy(s, layoutRows())["window-layout"] === "floating",
          "AeroSpace did not keep the owned window floating",
        );
        return { kind: "native-window", metrics: actual, restorationRequired: true };
      } catch (error) {
        throw new Error(
          error.message + "; saved resizeOriginal must be restored with window-restore",
        );
      }
    }
    const original = s.resizeOriginal;
    check(original, "No saved native resize to restore");
    check(
      row["monitor-id"] === original.row["monitor-id"],
      "Monitor changed during resize; preserve recovery state",
    );
    const bounds = { ...original.bounds };
    delete bounds.windowState;
    await browserCDP.send("Browser.setWindowBounds", { windowId: win.windowId, bounds });
    verifyProcess(s);
    resizePolicy(s, layoutRows());
    const oldLayout = original.row["window-layout"];
    if (oldLayout !== "floating") {
      run(["layout", "--window-id", String(s.nativeWindowId), "tiling"]);
      run(["layout", "--window-id", String(s.nativeWindowId), oldLayout]);
    }
    if (original.row["window-is-fullscreen"])
      run(["fullscreen", "on", "--window-id", String(s.nativeWindowId)]);
    const actual = await waitMetrics(client, original.metrics.width, original.metrics.height);
    const restored = resizePolicy(s, layoutRows());
    const actualBounds = (
      await browserCDP.send("Browser.getWindowBounds", { windowId: win.windowId })
    ).bounds;
    check(
      restored["window-layout"] === oldLayout &&
        restored["window-is-fullscreen"] === original.row["window-is-fullscreen"] &&
        ["left", "top", "width", "height", "windowState"].every(
          (k) => actualBounds[k] === original.bounds[k],
        ),
      "Native bounds/layout/fullscreen restoration unconfirmed; retain resizeOriginal",
    );
    const cleared = { ...s };
    delete cleared.resizeOriginal;
    writeRoute(statePath, cleared);
    return { kind: "native-window", restored: true, metrics: actual };
  });
}
export async function withViewport(client, requested, operation, restoration = {}) {
  if (!requested) return operation(await metrics(client));
  const physical = await metrics(client);
  restoration.baseline = physical;
  let attempted = false;
  try {
    attempted = true;
    await client.send("Emulation.setDeviceMetricsOverride", {
      ...requested,
      deviceScaleFactor: physical.dpr,
      mobile: false,
      dontSetVisibleSize: true,
    });
    const before = await waitMetrics(client, requested.width, requested.height);
    const result = await operation(before);
    await waitMetrics(client, requested.width, requested.height);
    return result;
  } finally {
    if (attempted) {
      await client.send("Emulation.clearDeviceMetricsOverride");
      // Chrome can defer restoring an inactive surface until this session detaches.
      // The caller verifies the actual baseline through a fresh owned connection.
    }
  }
}
async function verifyViewportRestoration(statePath, task, restoration) {
  if (!restoration.baseline) return;
  await withOwnedPage(statePath, task, async ({ client }) => {
    const baseline = restoration.baseline;
    const actual = await waitMetrics(client, baseline.width, baseline.height);
    check(
      actual.dpr === baseline.dpr &&
        actual.scale === baseline.scale &&
        actual.zoom === baseline.zoom,
      "Renderer scale/zoom restoration failed",
    );
  });
}
export async function backgroundCommand(command, statePath, task, flags) {
  const size =
    ["viewport", "window-resize"].includes(command) ||
    (command === "screenshot" &&
      (flags["--width"] !== undefined || flags["--height"] !== undefined))
      ? dimensions(flags["--width"], flags["--height"])
      : undefined;
  if (command === "window-resize" || command === "window-restore")
    return windowResize(statePath, task, size, command === "window-restore");
  if (command === "screenshot") {
    check(
      typeof flags["--path"] === "string",
      "Screenshot requires an explicit private output path",
    );
    const output = resolve(flags["--path"]);
    check(
      realpathSync(dirname(output)) === dirname(output),
      "Screenshot output parent must be canonical",
    );
    const restoration = {};
    const capture = await withOwnedPage(statePath, task, ({ state, client }) =>
      withViewport(
        client,
        size ?? state.viewportPolicy,
        async (before) => {
          const response = await client.send("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
          });
          const after = await metrics(client);
          check(
            before.width === after.width &&
              before.height === after.height &&
              before.dpr === after.dpr &&
              before.scale === after.scale &&
              before.zoom === after.zoom,
            "Viewport changed during capture",
          );
          const png = Buffer.from(response.data ?? "", "base64");
          check(
            png.length > 24 &&
              png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
            "Browser did not return PNG pixels",
          );
          check(
            png.readUInt32BE(16) === Math.round(before.width * before.dpr) &&
              png.readUInt32BE(20) === Math.round(before.height * before.dpr),
            "PNG dimensions do not match the measured CSS viewport and DPR",
          );
          return { png, metrics: before, afterMetrics: after };
        },
        restoration,
      ),
    );
    await verifyViewportRestoration(statePath, task, restoration);
    writeFileSync(output, capture.png, { flag: "wx", mode: 0o600 });
    return {
      path: output,
      kind: "renderer-screenshot",
      metrics: capture.metrics,
      afterMetrics: capture.afterMetrics,
    };
  }
  const restoration = {};
  const value = await withOwnedPage(statePath, task, async ({ state: s, client }) => {
    if (command === "diagnostics")
      return withViewport(
        client,
        s.viewportPolicy,
        async (actual) => {
          await client.send("Performance.enable");
          const perf = await client.send("Performance.getMetrics");
          const allowed = new Set([
            "Documents",
            "Frames",
            "Nodes",
            "LayoutCount",
            "RecalcStyleCount",
            "JSHeapUsedSize",
          ]);
          return {
            kind: "background-diagnostics",
            metrics: actual,
            performance: perf.metrics.filter((m) => allowed.has(m.name)),
          };
        },
        restoration,
      );
    if (command === "viewport") {
      check(!s.resizeOriginal, "Restore native window resize before configuring a viewport policy");
      const actual = await withViewport(client, size, async (current) => current, restoration);
      writeRoute(statePath, { ...s, viewportPolicy: size });
      return {
        kind: "viewport-policy",
        policy: size,
        verifiedMetrics: actual,
        activeOutsideHelper: false,
      };
    }
    if (command === "viewport-reset") {
      check(s.viewportPolicy, "No helper-owned viewport policy to reset");
      const cleared = { ...s };
      delete cleared.viewportPolicy;
      writeRoute(statePath, cleared);
      return { policyRemoved: true, metrics: await metrics(client) };
    }
    throw new Error("Unsupported background operation");
  });
  await verifyViewportRestoration(statePath, task, restoration);
  return value;
}
