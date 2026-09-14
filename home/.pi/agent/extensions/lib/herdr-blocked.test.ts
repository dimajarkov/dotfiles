import assert from "node:assert/strict";
import test from "node:test";
import { withHerdrBlocked } from "./herdr-blocked.ts";

test("blocked state balances around success, cancellation, and errors", async () => {
  for (const outcome of ["success", "cancel", "error"] as const) {
    const events: unknown[] = [];
    const operation = async () => {
      if (outcome === "error") throw new Error("failed dialog");
      return outcome;
    };
    if (outcome === "error") {
      await assert.rejects(
        withHerdrBlocked((event) => events.push(event), "Question", operation),
        /failed dialog/,
      );
    } else {
      assert.equal(
        await withHerdrBlocked((event) => events.push(event), "Question", operation),
        outcome,
      );
    }
    assert.deepEqual(events, [
      { active: true, label: "Question" },
      { active: false },
    ]);
  }
});
