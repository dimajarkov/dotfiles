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

test("redacts credentials from OAuth and route-query URL fragments in rendered details", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/oauth#access_token=oauth-hash-secret&state=keep-hash-state",
        resourceType: "fetch",
        responseHeaders: {
          Location:
            "/callback#/finish?refreshToken=relative-fragment-secret&idtoken=compact-fragment-secret&signature256=signature-fragment-secret&state=keep-route-state",
        },
      },
    ],
    true,
    new Set(["location"]),
  );

  assert.match(
    result.text,
    /https:\/\/example\.test\/oauth#access_token=%5BREDACTED%5D&state=keep-hash-state/,
  );
  assert.match(
    result.text,
    /Location: \/callback#\/finish\?refreshToken=%5BREDACTED%5D&idtoken=%5BREDACTED%5D&signature256=%5BREDACTED%5D&state=keep-route-state/,
  );
  assert.equal(
    result.entries[0].url,
    "https://example.test/oauth#access_token=%5BREDACTED%5D&state=keep-hash-state",
  );
  assert.equal(
    result.entries[0].responseHeaders.Location,
    "/callback#/finish?refreshToken=%5BREDACTED%5D&idtoken=%5BREDACTED%5D&signature256=%5BREDACTED%5D&state=keep-route-state",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /(?:oauth-hash|relative-fragment|compact-fragment|signature-fragment)-secret/,
  );
});

test("preserves harmless URL anchors while serializing network details", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/docs#installation",
        resourceType: "document",
        responseHeaders: { location: "/docs#troubleshooting" },
      },
    ],
    true,
    new Set(["location"]),
  );

  assert.match(result.text, /https:\/\/example\.test\/docs#installation/);
  assert.match(result.text, /location: \/docs#troubleshooting/);
  assert.equal(result.entries[0].url, "https://example.test/docs#installation");
  assert.equal(result.entries[0].responseHeaders.location, "/docs#troubleshooting");
});
