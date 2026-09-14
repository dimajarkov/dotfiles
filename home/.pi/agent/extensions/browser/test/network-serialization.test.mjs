import assert from "node:assert/strict";
import { test } from "node:test";
import { serializeNetworkEntries } from "../network-serialization.ts";

test("network output preserves header presence without exposing credentials", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://user:private-password@example.test/data?access_token=private-query&page=1",
        status: 200,
        resourceType: "fetch",
        requestHeaders: {
          Authorization: "Bearer private-token",
          apikey: "private-api-key",
          cookie: "session=private-cookie",
          "x-custom-secret": "private-custom-secret",
          "content-type": "application/json",
        },
        responseHeaders: {
          location: "/callback?code=private-code",
          "set-cookie": "session=private-response-cookie",
        },
      },
    ],
    true,
    new Set([
      "authorization",
      "apikey",
      "cookie",
      "x-custom-secret",
      "content-type",
      "location",
      "set-cookie",
    ]),
  );

  assert.match(result.text, /Authorization: \[REDACTED\]/);
  assert.match(result.text, /content-type: application\/json/);
  assert.equal(result.entries[0].requestHeaders.Authorization, "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.cookie, "[REDACTED]");
  assert.equal(result.entries[0].responseHeaders["set-cookie"], "[REDACTED]");
  assert.match(result.entries[0].url, /page=1/);
  assert.match(result.entries[0].responseHeaders.location, /code=%5BREDACTED%5D/);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("camelCase credential names are redacted in headers and URLs", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "POST",
        url: "https://example.test/refresh?refreshToken=private-refresh-token",
        resourceType: "fetch",
        requestHeaders: {
          refreshToken: "private-refresh-token",
          idToken: "private-id-token",
          clientSecret: "private-client-secret",
        },
      },
    ],
    true,
    new Set(["refreshtoken", "idtoken", "clientsecret"]),
  );

  assert.match(result.text, /refreshToken: \[REDACTED\]/);
  assert.match(result.text, /idToken: \[REDACTED\]/);
  assert.match(result.text, /clientSecret: \[REDACTED\]/);
  assert.equal(result.entries[0].requestHeaders.refreshToken, "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.idToken, "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.clientSecret, "[REDACTED]");
  assert.match(result.entries[0].url, /refreshToken=%5BREDACTED%5D/);
  assert.doesNotMatch(JSON.stringify(result), /private-/);
});

test("transport-normalized compact credential names remain redacted", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "POST",
        url: "https://example.test/refresh?refreshtoken=compact-refresh-secret",
        resourceType: "fetch",
        requestHeaders: {
          refreshtoken: "compact-refresh-secret",
          idtoken: "compact-id-secret",
          clientsecret: "compact-client-secret",
        },
      },
    ],
    true,
    new Set(["refreshtoken", "idtoken", "clientsecret"]),
  );

  assert.match(result.text, /refreshtoken: \[REDACTED\]/);
  assert.match(result.text, /idtoken: \[REDACTED\]/);
  assert.match(result.text, /clientsecret: \[REDACTED\]/);
  assert.equal(result.entries[0].requestHeaders.refreshtoken, "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.idtoken, "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.clientsecret, "[REDACTED]");
  assert.match(result.entries[0].url, /refreshtoken=%5BREDACTED%5D/);
  assert.doesNotMatch(JSON.stringify(result), /compact-/);
});

test("signature authentication headers are redacted in structured and rendered output", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "POST",
        url: "https://example.test/webhook",
        resourceType: "fetch",
        requestHeaders: {
          "stripe-signature": "stripe-proof-secret",
          "x-hub-signature-256": "hub-proof-secret",
          signature256: "compact-proof-secret",
        },
      },
    ],
    true,
    new Set(["stripe-signature", "x-hub-signature-256", "signature256"]),
  );

  assert.match(result.text, /stripe-signature: \[REDACTED\]/);
  assert.match(result.text, /x-hub-signature-256: \[REDACTED\]/);
  assert.match(result.text, /signature256: \[REDACTED\]/);
  assert.equal(result.entries[0].requestHeaders["stripe-signature"], "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders["x-hub-signature-256"], "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders.signature256, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /proof-secret/);
});
