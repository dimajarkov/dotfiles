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

export const RECOGNIZABLE_CREDENTIAL_PREFIXES = [
  /github_pat_[A-Za-z\d_]{8,}/u,
  /gh[pousr]_[A-Za-z\d]{8,}/u,
  /gl(?:agent|cbt|dt|ffct|ft|imt|oas|pat|ptt|rt|soat)-[A-Za-z\d_-]{8,}/u,
  /xox[aboprs]-[A-Za-z\d-]{8,}/u,
  /(?:sk|rk)_(?:live|test)_[A-Za-z\d]{8,}/u,
  /whsec_[A-Za-z\d_-]{8,}/u,
  /sk-(?:proj-|svcacct-)?[A-Za-z\d_-]{8,}/u,
  /AIza[A-Za-z\d_-]{8,}/u,
  /(?:AKIA|ASIA|AIDA|AROA|ANPA|ANVA|ASCA)[A-Z\d]{8,}/u,
  /pypi-[A-Za-z\d_-]{8,}/u,
  /npm_[A-Za-z\d_-]{8,}/u,
  /hf_[A-Za-z\d]{8,}/u,
  /dop_v1_[A-Fa-f\d]{8,}/u,
  /shp(?:at|ca|pa|ss)_[A-Fa-f\d]{8,}/u,
  /SG\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}/u,
] as const;

const EXACT_CREDENTIAL_PREFIXES = RECOGNIZABLE_CREDENTIAL_PREFIXES.map(
  (pattern) => new RegExp(`^(?:${pattern.source})$`, pattern.flags),
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
    /(?:accesskey|privatekey|passwd)$/u.test(compact) ||
    /(?:bearer|dpop|dpopproof)$/u.test(compact) ||
    /(?:assertion|jwt|samlart|samlrequest|samlresponse)$/u.test(compact) ||
    /(?:api(?:cation)?key|credentials?|password|secret|token|signature\d*)$/u.test(compact) ||
    /(?:^|[-_.~])(?:access[-_]?token|api[-_]?key|credential|password|secret|token)(?:$|[-_.~])/iu.test(
      normalized,
    ) ||
    /(?:^|[-_.~])(?:hmac|signature)(?:$|[-_.~]|\d)/iu.test(normalized)
  );
}

export function redactRecognizableCredentialValues(text: string): string {
  return RECOGNIZABLE_CREDENTIAL_PREFIXES.reduce(
    (redacted, pattern) =>
      redacted.replace(
        new RegExp(pattern.source, `${pattern.flags}g`),
        "[REDACTED]",
      ),
    text,
  );
}

export function isCredentialValue(value: string): boolean {
  const normalized = value.normalize("NFKC");
  if (EXACT_CREDENTIAL_PREFIXES.some((pattern) => pattern.test(normalized))) return true;
  if (/^[A-Za-z\d_-]{8,}(?:\.[A-Za-z\d_-]{2,}){2}(?:\.[A-Za-z\d_-]{2,}){0,2}$/u.test(normalized)) {
    return true;
  }
  return (
    normalized.length >= 32 &&
    /^[A-Za-z\d+/_~-]+={0,2}$/u.test(normalized) &&
    /[a-z]/u.test(normalized) &&
    /[A-Z]/u.test(normalized) &&
    /\d/u.test(normalized)
  );
}
