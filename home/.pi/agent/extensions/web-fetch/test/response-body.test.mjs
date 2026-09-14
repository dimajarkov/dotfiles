import assert from "node:assert/strict";
import { test } from "node:test";
import { readResponseBytes, readResponseText } from "../response-body.ts";

function chunkedResponse(chunkBytes, chunkCount) {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (pulls === chunkCount) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  return { response, state: () => ({ pulls, cancelled }) };
}

test("chunked text responses are cancelled at the byte limit", async () => {
  const source = chunkedResponse(1024 * 1024, 20);
  await assert.rejects(readResponseText(source.response, 5 * 1024 * 1024), /exceeds 5MB/);
  assert.equal(source.state().cancelled, true);
  assert.ok(source.state().pulls <= 7);
});

test("chunked PDF responses use the larger limit and still stop streaming", async () => {
  const source = chunkedResponse(3 * 1024 * 1024, 20);
  await assert.rejects(readResponseBytes(source.response, 20 * 1024 * 1024), /exceeds 20MB/);
  assert.equal(source.state().cancelled, true);
  assert.ok(source.state().pulls <= 8);
});

test("bounded responses remain readable", async () => {
  const response = new Response("bounded response");
  assert.equal(await readResponseText(response, 1024), "bounded response");
});
