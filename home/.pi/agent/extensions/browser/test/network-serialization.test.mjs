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
