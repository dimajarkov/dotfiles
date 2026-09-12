const SENSITIVE_NAMES = new Set([
  "authorization",
  "authentication-info",
  "proxy-authorization",
  "proxy-authentication-info",
  "apikey",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);

const SENSITIVE_COMPACT_NAMES = new Set(
  [...SENSITIVE_NAMES, "session-id"].map((name) => name.replace(/[-_]/g, "")),
);

export function isCredentialName(name: string): boolean {
  const normalized = name
    .normalize("NFKC")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const compact = normalized.replace(/[-_.~]/gu, "");
  return (
    SENSITIVE_NAMES.has(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact) ||
    /(?:authorization|authentication(?:info)?)$/u.test(compact) ||
    /(?:authorizationcode|codeverifier|devicecode|devicegrantcode|oauthverifier|pkceverifier|usercode)$/u.test(
      compact,
    ) ||
    /(?:bearer|dpop|dpopproof)$/u.test(compact) ||
    /(?:assertion|jwt|samlart|samlrequest|samlresponse)$/u.test(compact) ||
    /(?:api(?:cation)?key|credentials?|password|secret|token|signature\d*)$/u.test(compact) ||
    /(?:^|[-_.~])(?:access[-_]?token|api[-_]?key|credential|password|secret|token)(?:$|[-_.~])/iu.test(
      normalized,
    ) ||
    /(?:^|[-_.~])(?:hmac|signature)(?:$|[-_.~]|\d)/iu.test(normalized)
  );
}
