export type NetworkEntry = {
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failure?: string;
};

const REDACTED = "[REDACTED]";
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "apikey",
  "x-api-key",
  "x-auth-token",
  "cookie",
  "set-cookie",
]);
const SENSITIVE_COMPACT_NAMES = new Set(
  [...SENSITIVE_HEADER_NAMES, "session-id"].map((name) => name.replace(/[-_]/g, "")),
);
const URL_BEARING_HEADER_NAMES = new Set([
  "content-location",
  "destination",
  "location",
  "origin",
  "referer",
  "referrer",
  "source-map",
  "x-original-url",
  "x-rewrite-url",
  "x-source-map",
]);
const ENCODED_REDACTED = encodeURIComponent(REDACTED);

function isSensitiveName(name: string): boolean {
  const normalized = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
  const compact = normalized.replace(/[-_]/g, "");
  return (
    SENSITIVE_HEADER_NAMES.has(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact) ||
    /(?:api(?:cation)?key|credentials?|password|secret|token|signature\d*)$/u.test(compact) ||
    /(?:^|[-_])(?:access[-_]?token|api[-_]?key|credential|password|secret|token)(?:$|[-_])/i.test(
      normalized,
    ) ||
    /(?:^|[-_])(?:hmac|signature)(?:$|[-_]|\d)/i.test(normalized)
  );
}

function isSensitiveUrlParameter(name: string): boolean {
  return isSensitiveName(name) || /^(?:code|key|sig|signature)$/i.test(name);
}

function decodeParameterName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, " "));
  } catch {
    return name;
  }
}

function redactParameterText(value: string): { value: string; changed: boolean } {
  let changed = false;
  const redacted = value
    .split("&")
    .map((parameter) => {
      const equals = parameter.indexOf("=");
      const name = equals === -1 ? parameter : parameter.slice(0, equals);
      if (!isSensitiveUrlParameter(decodeParameterName(name))) return parameter;
      changed = true;
      return `${name}=${ENCODED_REDACTED}`;
    })
    .join("&");
  return { value: redacted, changed };
}

function redactFragment(hash: string): string {
  if (!hash) return hash;

  let changed = false;
  const fragments = hash.slice(1).split("#").map((fragment) => {
    const queryStart = fragment.indexOf("?");
    const parameterText = queryStart === -1 ? fragment : fragment.slice(queryStart + 1);
    const redacted = redactParameterText(parameterText);
    if (!redacted.changed) return fragment;

    changed = true;
    const prefix = queryStart === -1 ? "" : fragment.slice(0, queryStart + 1);
    return `${prefix}${redacted.value}`;
  });

  return changed ? `#${fragments.join("#")}` : hash;
}

function redactAuthorityCredentials(value: string): string {
  const prefix = /^(?:[a-z][a-z\d+.-]*:)?\/\//i.exec(value)?.[0];
  if (!prefix) return value;

  const authorityStart = prefix.length;
  const authorityEndOffset = value.slice(authorityStart).search(/[/?#]/u);
  const authorityEnd =
    authorityEndOffset === -1 ? value.length : authorityStart + authorityEndOffset;
  const authority = value.slice(authorityStart, authorityEnd);
  const at = authority.lastIndexOf("@");
  if (at === -1) return value;

  const userInfo = authority.slice(0, at);
  const replacement = userInfo.includes(":")
    ? `${ENCODED_REDACTED}:${ENCODED_REDACTED}`
    : ENCODED_REDACTED;
  return `${value.slice(0, authorityStart)}${replacement}@${authority.slice(at + 1)}${value.slice(authorityEnd)}`;
}

function redactMatchedUrl(value: string): string {
  const suffix = /[),.;:!?\]}]+$/u.exec(value)?.[0] ?? "";
  const url = suffix ? value.slice(0, -suffix.length) : value;
  return `${redactBrowserUrl(url)}${suffix}`;
}

export function redactBrowserUrl(value: string): string {
  const fragmentStart = value.indexOf("#");
  const beforeFragment = fragmentStart === -1 ? value : value.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? "" : value.slice(fragmentStart);
  const queryStart = beforeFragment.indexOf("?");
  const beforeQuery = queryStart === -1 ? beforeFragment : beforeFragment.slice(0, queryStart);
  const query = queryStart === -1 ? "" : beforeFragment.slice(queryStart + 1);
  const redactedQuery = redactParameterText(query);
  const redacted = `${beforeQuery}${queryStart === -1 ? "" : `?${redactedQuery.value}`}${redactFragment(fragment)}`;
  return redactAuthorityCredentials(redacted);
}

export function redactBrowserDiagnostic(value: string): string {
  return value.replace(
    /(?:\b[a-z][a-z\d+.-]*:(?:\/\/)?|\/\/)[^\s<>"'`]+/giu,
    redactMatchedUrl,
  );
}

function redactLinkHeader(value: string): string {
  const targets = value.replace(
    /<([^>]*)>/gu,
    (_match, url: string) => `<${redactBrowserUrl(url)}>`,
  );
  return redactBrowserDiagnostic(targets);
}

function redactRefreshHeader(value: string): string {
  const match = /\burl\s*=\s*/iu.exec(value);
  if (!match) return value;
  const start = match.index + match[0].length;
  const quote = value[start] === '"' || value[start] === "'" ? value[start] : undefined;
  if (!quote) {
    const trailingWhitespace = /\s*$/u.exec(value.slice(start))?.[0] ?? "";
    const end = value.length - trailingWhitespace.length;
    return `${value.slice(0, start)}${redactBrowserUrl(value.slice(start, end))}${value.slice(end)}`;
  }

  let end = start + 1;
  while (end < value.length) {
    if (value[end] === quote) {
      let backslashes = 0;
      for (let cursor = end - 1; cursor >= start && value[cursor] === "\\"; cursor -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2 === 0) break;
    }
    end += 1;
  }
  return `${value.slice(0, start + 1)}${redactBrowserUrl(value.slice(start + 1, end))}${value.slice(end)}`;
}

function redactHeaderValue(name: string, value: string): string {
  if (isSensitiveName(name)) return REDACTED;
  const normalizedName = name.toLowerCase();
  if (normalizedName === "link") return redactLinkHeader(value);
  if (normalizedName === "refresh") return redactRefreshHeader(value);
  if (URL_BEARING_HEADER_NAMES.has(normalizedName)) {
    return redactBrowserUrl(value);
  }
  return redactBrowserDiagnostic(value);
}

function redactHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, redactHeaderValue(name, value)]),
  );
}

export function serializeNetworkEntries(
  entries: NetworkEntry[],
  showHeaders: boolean,
  allowedHeaders: Set<string>,
): { text: string; entries: NetworkEntry[] } {
  const safeEntries = entries.map((entry) => ({
    ...entry,
    url: redactBrowserUrl(entry.url),
    ...(entry.statusText === undefined
      ? {}
      : { statusText: redactBrowserDiagnostic(entry.statusText) }),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
    ...(entry.failure === undefined
      ? {}
      : { failure: redactBrowserDiagnostic(entry.failure) }),
  }));
  const lines: string[] = [];

  for (const entry of safeEntries) {
    lines.push(
      `${entry.status ?? "ERR"} ${entry.method} ${entry.url}${entry.failure ? `  (${entry.failure})` : ""}`,
    );
    if (!showHeaders) continue;

    for (const [name, value] of Object.entries(entry.requestHeaders ?? {})) {
      if (allowedHeaders.has(name.toLowerCase())) lines.push(`  → ${name}: ${value}`);
    }
    for (const [name, value] of Object.entries(entry.responseHeaders ?? {})) {
      if (allowedHeaders.has(name.toLowerCase())) lines.push(`  ← ${name}: ${value}`);
    }
  }

  return { text: lines.join("\n") || "(empty)", entries: safeEntries };
}
