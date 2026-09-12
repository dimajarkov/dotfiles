import assert from "node:assert/strict";
import { test } from "node:test";
import { eligibleJinaFallbackUrl, runEligibleJinaFallback } from "../jina-fallback.ts";

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
    assert.equal(
      await runEligibleJinaFallback(url, fallback, {
        allowThirdPartyFallback: true,
        resolve,
      }),
      null,
    );
  }

  assert.equal(fallbackCalls, 0);
  assert.equal(resolverCalls, 0);
});

test("path-secret URLs remain ineligible with explicit third-party authorization", async () => {
  let fallbackCalls = 0;
  let resolverCalls = 0;
  for (const url of [
    "https://docs.github.com/en/github_pat_secret",
    "https://docs.github.com/en/github_pat_%2573ecret",
    "https://docs.github.com/en%2Faccess_token%2Fvalue",
    "https://docs.github.com/en/malformed%escape",
  ]) {
    assert.equal(
      await runEligibleJinaFallback(
        url,
        async () => {
          fallbackCalls += 1;
          return "unexpected";
        },
        {
          allowThirdPartyFallback: true,
          resolve: async () => {
            resolverCalls += 1;
            return [{ address: "13.107.42.14", family: 4 }];
          },
        },
      ),
      null,
      url,
    );
  }
  assert.equal(fallbackCalls, 0);
  assert.equal(resolverCalls, 0);
});

test("authentication proof paths remain ineligible with explicit authorization", async () => {
  let fallbackCalls = 0;
  let resolverCalls = 0;
  for (const url of [
    "https://docs.github.com/en/jwt/eyJhbGciOiJIUzI1NiJ9.abc.xyz",
    "https://docs.github.com/en/%256a%2577%2574/eyJhbGciOiJIUzI1NiJ9.abc.xyz",
    "https://docs.github.com/en/dpop-proof/eyJ0eXAiOiJkcG9wK2p3dCJ9.abc.xyz",
    "https://docs.github.com/en/SAMLResponse/PHNhbWxwOlJlc3BvbnNlIElEPSJzZWNyZXQiPjEyMzQ1Njc4OTA=",
    "https://docs.github.com/en/bearer/aB3dE5fG7hJ9kL1mN3pQ5rS7tV9xY2zA",
    "https://docs.github.com/en/client_assertion/eyJhbGciOiJSUzI1NiJ9.abc.xyz",
    "https://docs.github.com/en/eyJhbGciOiJIUzI1NiJ9.abc.xyz",
  ]) {
    assert.equal(
      await runEligibleJinaFallback(
        url,
        async () => {
          fallbackCalls += 1;
          return "unexpected";
        },
        {
          allowThirdPartyFallback: true,
          resolve: async () => {
            resolverCalls += 1;
            return [{ address: "13.107.42.14", family: 4 }];
          },
        },
      ),
      null,
      url,
    );
  }
  assert.equal(fallbackCalls, 0);
  assert.equal(resolverCalls, 0);
});

test("DNS-private and mixed-resolution hosts fail closed", async () => {
  assert.equal(
    await eligibleJinaFallbackUrl("https://docs.github.com/en/get-started", async () => [
      { address: "10.0.0.8", family: 4 },
    ]),
    undefined,
  );
  assert.equal(
    await eligibleJinaFallbackUrl("https://docs.github.com/en/get-started", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "fd00::8", family: 6 },
    ]),
    undefined,
  );
});

test("clean public URLs may use the fallback", async () => {
  const calls = [];
  const result = await runEligibleJinaFallback(
    "https://docs.github.com/en/get-started",
    async (url) => {
      calls.push(url);
      return "reader output";
    },
    {
      allowThirdPartyFallback: true,
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ],
    },
  );

  assert.equal(result, "reader output");
  assert.deepEqual(calls, ["https://docs.github.com/en/get-started"]);
});

test("unlisted public hosts remain ineligible", async () => {
  let resolverCalls = 0;
  assert.equal(
    await eligibleJinaFallbackUrl("https://example.com/article", async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    }),
    undefined,
  );
  assert.equal(resolverCalls, 0);
});
