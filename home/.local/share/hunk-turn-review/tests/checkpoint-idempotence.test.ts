import { test, expect } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./runtime.test.js";

test("an identical checkpoint flush preserves the version while competing writers remain fenced", async () => {
  const f = await fixture();
  try {
    await f.call("request.begin", { requestId: "checkpoint-handoff" });
    await writeFile(join(f.checkout, "tracked.txt"), "Review content\n");
    const { reviewId } = await f.call("request.complete", {
      requestId: "checkpoint-handoff",
      outcome: "completed",
    });
    const checkpoint = {
      version: 1,
      checkoutRoot: f.checkout,
      reviewId,
      documentIdentity: "same-immutable-document",
      generation: "split-view",
      stateRevision: 2,
      notes: [],
      draft: null,
      selection: { fileKey: "native-file", hunkIndex: 0, activeNoteId: null },
    };
    expect(
      await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 0 }),
    ).toEqual({ version: 1 });
    expect(
      await f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 1 }),
    ).toEqual({ version: 1 });
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 1,
      checkpoint,
    });
    const adopted = { ...checkpoint, generation: "tab-view", stateRevision: 1 };
    expect(
      await f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: adopted,
        expectedVersion: 1,
      }),
    ).toEqual({ version: 2 });
    await expect(
      f.call("review.checkpoint.write", { reviewId, checkpoint, expectedVersion: 1 }),
    ).rejects.toThrow("conflict");
    const editing = {
      ...adopted,
      stateRevision: 2,
      draft: {
        id: "tab-draft",
        fileKey: "native-file",
        hunkIndex: 0,
        side: "new",
        line: 1,
        body: "Current tab composer",
      },
    };
    expect(
      await f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: editing,
        expectedVersion: 2,
      }),
    ).toEqual({ version: 3 });
    await expect(
      f.call("review.checkpoint.write", {
        reviewId,
        checkpoint: { ...adopted, stateRevision: 3 },
        expectedVersion: 2,
      }),
    ).rejects.toThrow("conflict");
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 3,
      checkpoint: editing,
    });
    expect((await f.call("review.status")).notes).toEqual([]);
    await f.restart();
    expect(await f.call("review.checkpoint.read", { reviewId })).toEqual({
      version: 3,
      checkpoint: editing,
    });
  } finally {
    await f.close();
  }
});
