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

function isSensitiveHeader(name: string): boolean {
  const normalized = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase();
  return (
    SENSITIVE_HEADER_NAMES.has(normalized) ||
    /(?:^|[-_])(?:access[-_]?token|api[-_]?key|credential|password|secret|token)(?:$|[-_])/i.test(
      normalized,
    )
  );
}

function redactUrl(value: string): string {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(value, "https://redaction.invalid");
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const name of new Set(url.searchParams.keys())) {
      if (isSensitiveHeader(name) || /^(?:code|key|sig|signature)$/i.test(name)) {
        url.searchParams.set(name, REDACTED);
      }
    }
    return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value;
  }
}

function redactHeaderValue(name: string, value: string): string {
  if (isSensitiveHeader(name)) return REDACTED;
  return name.toLowerCase() === "location" ? redactUrl(value) : value;
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
    url: redactUrl(entry.url),
    requestHeaders: redactHeaders(entry.requestHeaders),
    responseHeaders: redactHeaders(entry.responseHeaders),
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
