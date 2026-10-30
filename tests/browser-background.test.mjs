import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dimensions,
  resizePolicy,
} from "../home/.agents/skills/browser-routing/scripts/background.mjs";
test("native resize refuses shared workspace before layout changes", () => {
  const s = { nativeWindowId: 1, pid: 10, workspace: "qa-owned" };
  const owned = { "window-id": 1, "app-pid": 10, workspace: "qa-owned" };
  assert.equal(resizePolicy(s, [owned]), owned);
  assert.throws(
    () => resizePolicy(s, [owned, { "window-id": 2, "app-pid": 20, workspace: "qa-owned" }]),
    /shared workspace/,
  );
  assert.throws(() => resizePolicy(s, [{ ...owned, "app-pid": 20 }]), /ownership/);
  assert.throws(() => resizePolicy({ ...s, nativeWindowId: undefined }, [owned]), /mapped/);
});
test("CSS dimensions reject invalid or unbounded sizes before browser mutation", () => {
  assert.deepEqual(dimensions("600", "787"), { width: 600, height: 787 });
  for (const [w, h] of [
    [0, 787],
    [600, 0],
    [50000, 500],
    [600.5, 500],
    ["invalid", 500],
  ])
    assert.throws(() => dimensions(w, h), /Dimensions/);
});
