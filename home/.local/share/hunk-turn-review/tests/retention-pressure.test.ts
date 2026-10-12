import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./runtime.test.js";

test("same-day history evicted by storage pressure warns without losing protected reviews", async () => {
  const f = await fixture({ maxBytes: 24000, now: Date.parse("2026-10-12T00:00:00Z") });
  try {
    const reviews: string[] = [];
    for (const [requestId, contents] of [
      ["large-history", "A".repeat(60000)],
      ["later-history", "B".repeat(9000)],
      ["latest", "Latest content\n"],
    ]) {
      await f.call("request.begin", { requestId });
      await writeFile(join(f.checkout, "tracked.txt"), contents);
      const completed = await f.call("request.complete", { requestId, outcome: "completed" });
      reviews.push(completed.reviewId);
    }
    const latest = await f.call("review.get", { selection: "latest" });
    const cumulative = await f.call("review.get", { selection: "cumulative" });
    const retention = await f.call("maintenance.run");
    const after = await f.call("review.status");
    expect(retention.totalBytes).toBeLessThanOrEqual(retention.maxBytes);
    expect(retention.protectedBytes).toBeLessThanOrEqual(retention.maxBytes);
    expect(after.reviews).not.toContain(reviews[0]);
    expect(await f.call("review.get", { selection: "latest" })).toEqual(latest);
    expect(await f.call("review.get", { selection: "cumulative" })).toEqual(cumulative);
    expect(after.warnings.join("\n")).toContain("storage pressure");
    expect(after.warnings.join("\n")).toContain("before 30 days");
    await f.call("maintenance.run");
    await f.restart();
    const restored = await f.call("review.status");
    expect(restored.warnings).toEqual(after.warnings);
    expect(await f.call("review.get", { selection: "latest" })).toEqual(latest);
  } finally {
    await f.close();
  }
});
