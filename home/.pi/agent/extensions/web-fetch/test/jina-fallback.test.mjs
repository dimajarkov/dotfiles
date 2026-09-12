import assert from "node:assert/strict";
import { test } from "node:test";
import {
  eligibleJinaFallbackUrl,
  runEligibleJinaFallback,
} from "../jina-fallback.ts";

test("private, credential-bearing, and signed URLs never reach Jina", async () => {
  let fallbackCalls = 0;
  let resolverCalls = 0;
  const fallback = async () => {
    fallbackCalls += 1;
    return "unexpected";
  };
  const resolve = async () => {
    resolverCalls += 1;
    return [{ address: "93.184.216.34", family: 4 }];
  };

  for (const url of [
    "http://127.0.0.1/private",
    "http://metadata.internal/latest",
    "https://user:password@example.com/private",
    "https://example.com/download?X-Amz-Signature=secret",
    "file:///private/etc/hosts",
  ]) {
    assert.equal(await runEligibleJinaFallback(url, fallback, resolve), null);
  }

  assert.equal(fallbackCalls, 0);
  assert.equal(resolverCalls, 0);
});

test("DNS-private and mixed-resolution hosts fail closed", async () => {
  assert.equal(
    await eligibleJinaFallbackUrl("https://service.example.com/article", async () => [
      { address: "10.0.0.8", family: 4 },
    ]),
    undefined,
  );
  assert.equal(
    await eligibleJinaFallbackUrl("https://service.example.com/article", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::8", family: 6 },
    ]),
    undefined,
  );
});

test("clean public URLs may use the fallback", async () => {
  const calls = [];
  const result = await runEligibleJinaFallback(
    "https://example.com/article",
    async (url) => {
      calls.push(url);
      return "reader output";
    },
    async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ],
  );

  assert.equal(result, "reader output");
  assert.deepEqual(calls, ["https://example.com/article"]);
});
