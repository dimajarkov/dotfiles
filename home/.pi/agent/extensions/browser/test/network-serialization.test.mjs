import assert from "node:assert/strict";
import { test } from "node:test";
import {
  redactBrowserDiagnostic,
  redactBrowserUrl,
  serializeNetworkEntries,
} from "../network-serialization.ts";

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

test("authentication metadata headers are redacted at the shared boundary", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data",
        resourceType: "fetch",
        responseHeaders: {
          "Authentication-Info": 'nextnonce="authentication-secret"',
          "Proxy-Authentication-Info": 'nextnonce="proxy-secret"',
        },
      },
    ],
    true,
    new Set(["authentication-info", "proxy-authentication-info"]),
  );

  assert.match(result.text, /Authentication-Info: \[REDACTED\]/);
  assert.match(result.text, /Proxy-Authentication-Info: \[REDACTED\]/);
  assert.equal(result.entries[0].responseHeaders["Authentication-Info"], "[REDACTED]");
  assert.equal(result.entries[0].responseHeaders["Proxy-Authentication-Info"], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /(?:authentication|proxy)-secret/);
});

test("prefixed authorization and authentication headers are redacted", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data",
        resourceType: "fetch",
        requestHeaders: {
          "X-Authorization": "Bearer prefixed-authorization-secret",
          "Upstream-Authentication": "prefixed-authentication-secret",
          "Vendor-Authentication-Info": "prefixed-authentication-info-secret",
        },
      },
    ],
    true,
    new Set(["x-authorization", "upstream-authentication", "vendor-authentication-info"]),
  );

  assert.equal(result.entries[0].requestHeaders["X-Authorization"], "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders["Upstream-Authentication"], "[REDACTED]");
  assert.equal(result.entries[0].requestHeaders["Vendor-Authentication-Info"], "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(result), /prefixed-.*-secret/);
});

test("session credential aliases are redacted in URLs and URL-bearing headers", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data?session=session-secret&sid=sid-secret&view=keep",
        resourceType: "fetch",
        responseHeaders: {
          Location:
            "/callback?jsessionid=java-session-secret&phpsessid=php-session-secret&state=keep",
        },
      },
    ],
    true,
    new Set(["location"]),
  );

  assert.equal(
    result.entries[0].url,
    "https://example.test/data?session=%5BREDACTED%5D&sid=%5BREDACTED%5D&view=keep",
  );
  assert.equal(
    result.entries[0].responseHeaders.Location,
    "/callback?jsessionid=%5BREDACTED%5D&phpsessid=%5BREDACTED%5D&state=keep",
  );
  assert.doesNotMatch(JSON.stringify(result), /(?:session|sid|java-session|php-session)-secret/);
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

test("redacts URL-bearing headers in structured and rendered network output", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data",
        resourceType: "fetch",
        requestHeaders: {
          Referer: "https://app.test/page?access_token=referer-secret&view=keep",
        },
        responseHeaders: {
          "Content-Location": "next?refreshToken=content-secret&view=keep",
        },
      },
    ],
    true,
    new Set(["referer", "content-location"]),
  );

  assert.match(
    result.text,
    /Referer: https:\/\/app\.test\/page\?access_token=%5BREDACTED%5D&view=keep/,
  );
  assert.match(result.text, /Content-Location: next\?refreshToken=%5BREDACTED%5D&view=keep/);
  assert.equal(
    result.entries[0].requestHeaders.Referer,
    "https://app.test/page?access_token=%5BREDACTED%5D&view=keep",
  );
  assert.equal(
    result.entries[0].responseHeaders["Content-Location"],
    "next?refreshToken=%5BREDACTED%5D&view=keep",
  );
  assert.doesNotMatch(JSON.stringify(result), /(?:referer|content)-secret/);
});

test("redacts every URI in composite URL-bearing headers without changing their syntax", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data",
        resourceType: "fetch",
        responseHeaders: {
          Link: '<https://cdn.example/a?access_token=first-secret>; rel="next", </b?code=second-secret>; rel="alternate"',
          Refresh: '5; URL = "https://app.example/callback?refreshToken=refresh-secret&state=keep"',
          "WWW-Authenticate":
            'Bearer authorization_uri="https://login.example/authorize?clientSecret=auth-secret"',
        },
      },
    ],
    true,
    new Set(["link", "refresh", "www-authenticate"]),
  );

  assert.equal(
    result.entries[0].responseHeaders.Link,
    '<https://cdn.example/a?access_token=%5BREDACTED%5D>; rel="next", </b?code=%5BREDACTED%5D>; rel="alternate"',
  );
  assert.equal(
    result.entries[0].responseHeaders.Refresh,
    '5; URL = "https://app.example/callback?refreshToken=%5BREDACTED%5D&state=keep"',
  );
  assert.equal(
    result.entries[0].responseHeaders["WWW-Authenticate"],
    'Bearer authorization_uri="https://login.example/authorize?clientSecret=%5BREDACTED%5D"',
  );
  assert.doesNotMatch(JSON.stringify(result), /(?:first|second|refresh|auth)-secret/);
});

test("redacts URL credentials from network failure diagnostics", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/data",
        resourceType: "fetch",
        failure: "request failed at https://dead.invalid/callback?access_token=failure-secret.",
      },
    ],
    false,
    new Set(),
  );

  assert.equal(
    result.entries[0].failure,
    "request failed at https://dead.invalid/callback?access_token=%5BREDACTED%5D.",
  );
  assert.doesNotMatch(JSON.stringify(result), /failure-secret/);
});

test("redacts credential parameters from every diagnostic URL form", () => {
  const diagnostic = [
    "GET callback?access_token=bare-secret failed",
    "GET ./callback?refreshToken=dot-secret failed",
    "GET ../callback?code=parent-secret failed",
    "GET /callback?token=root-secret failed",
    "GET ?clientSecret=query-secret failed",
    "GET #idToken=fragment-secret failed",
    "GET //app.test/callback?signature=network-secret failed",
    "GET https://app.test/callback?key=absolute-secret failed",
    "GET (/callback??access_token=malformed-secret).",
    "GET /public?view=harmless unchanged",
  ].join("\n");

  assert.equal(
    redactBrowserDiagnostic(diagnostic),
    [
      "GET callback?access_token=%5BREDACTED%5D failed",
      "GET ./callback?refreshToken=%5BREDACTED%5D failed",
      "GET ../callback?code=%5BREDACTED%5D failed",
      "GET /callback?token=%5BREDACTED%5D failed",
      "GET ?clientSecret=%5BREDACTED%5D failed",
      "GET #idToken=%5BREDACTED%5D failed",
      "GET //app.test/callback?signature=%5BREDACTED%5D failed",
      "GET https://app.test/callback?key=%5BREDACTED%5D failed",
      "GET (/callback??access_token=%5BREDACTED%5D).",
      "GET /public?view=harmless unchanged",
    ].join("\n"),
  );
  assert.doesNotMatch(
    redactBrowserDiagnostic(diagnostic),
    /(?:bare|dot|parent|root|query|fragment|network|absolute|malformed)-secret/,
  );
});

test("preserves URL forms while redacting malformed and credential-bearing values", () => {
  assert.equal(redactBrowserUrl("next?state=1"), "next?state=1");
  assert.equal(
    redactBrowserUrl("//auth.example/callback?state=1"),
    "//auth.example/callback?state=1",
  );
  assert.equal(redactBrowserUrl("/callback?state=1"), "/callback?state=1");
  assert.equal(
    redactBrowserUrl("https://example.test:bad/callback?access_token=invalid-secret&state=1"),
    "https://example.test:bad/callback?access_token=%5BREDACTED%5D&state=1",
  );
  assert.equal(
    redactBrowserUrl("https://user:password@example.test/callback?state=1"),
    "https://%5BREDACTED%5D:%5BREDACTED%5D@example.test/callback?state=1",
  );
});

test("redacts semicolon query and matrix credentials while preserving harmless parameters", () => {
  assert.equal(
    redactBrowserUrl("/callback?next=1;access_token=query-secret&view=keep"),
    "/callback?next=1;access_token=%5BREDACTED%5D&view=keep",
  );
  assert.equal(
    redactBrowserUrl("/account;session_id=matrix-secret/view;token=path-secret?view=keep"),
    "/account;session_id=%5BREDACTED%5D/view;token=%5BREDACTED%5D?view=keep",
  );
  assert.equal(
    redactBrowserUrl("callback??next=1;clientSecret=malformed-secret"),
    "callback??next=1;clientSecret=%5BREDACTED%5D",
  );
  assert.equal(
    redactBrowserUrl("/callback#next=1;refreshToken=fragment-secret"),
    "/callback#next=1;refreshToken=%5BREDACTED%5D",
  );
  assert.equal(
    redactBrowserUrl("/public;view=compact?next=1;display=full#section;mode=wide"),
    "/public;view=compact?next=1;display=full#section;mode=wide",
  );
});

test("strips terminal controls from structured and rendered network fields", () => {
  const result = serializeNetworkEntries(
    [
      {
        ts: 1,
        method: "GET",
        url: "https://example.test/path\x1b]52;c;URL-CONTROL\x07",
        status: 500,
        statusText: "Remote\x1b]52;c;STATUS-CONTROL\x07 Error",
        resourceType: "fetch",
        requestHeaders: {
          "X-Diagnostic": "before\x1b]52;c;HEADER-CONTROL\x07after",
        },
        failure: "failed\x1b]52;c;FAILURE-CONTROL\x07 safely",
      },
    ],
    true,
    new Set(["x-diagnostic"]),
  );

  assert.equal(result.entries[0].url, "https://example.test/path");
  assert.equal(result.entries[0].statusText, "Remote Error");
  assert.equal(result.entries[0].requestHeaders["X-Diagnostic"], "beforeafter");
  assert.equal(result.entries[0].failure, "failed safely");
  assert.doesNotMatch(JSON.stringify(result), /(?:URL|STATUS|HEADER|FAILURE)-CONTROL|\x1b\]52;/u);
  assert.doesNotMatch(result.text, /\x1b\]52;/u);
});
