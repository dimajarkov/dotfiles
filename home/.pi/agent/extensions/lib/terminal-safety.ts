const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "file:"]);

function stripEscapeSequences(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] !== "\x1b") {
      result += value[index];
      index += 1;
      continue;
    }

    const next = value[index + 1];
    if (next === "[") {
      index += 2;
      while (index < value.length) {
        const codePoint = value.charCodeAt(index);
        index += 1;
        if (codePoint >= 0x40 && codePoint <= 0x7e) break;
      }
      continue;
    }

    if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
      index += 2;
      while (index < value.length) {
        if (value[index] === "\x07") {
          index += 1;
          break;
        }
        if (value[index] === "\x1b" && value[index + 1] === "\\") {
          index += 2;
          break;
        }
        index += 1;
      }
      continue;
    }

    index += 1;
    while (index < value.length) {
      const codePoint = value.charCodeAt(index);
      index += 1;
      if (codePoint >= 0x30 && codePoint <= 0x7e) break;
      if (codePoint < 0x20 || codePoint > 0x2f) break;
    }
  }
  return result;
}

export function sanitizeOutput(text: string): string {
  const normalized = stripEscapeSequences(text)
    .replace(/\r\n?/gu, "\n")
    .replace(/\u2028|\u2029/gu, "\n")
    .replace(/\t/gu, "    ");
  let result = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    const isControl =
      codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x0c) ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f);
    const isBidiFormat =
      (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (!isControl && !isBidiFormat) result += character;
  }
  return result;
}

export function sanitizeMetadata(value: unknown): string {
  return sanitizeOutput(typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function sanitizeRenderedOutput(text: string): string {
  // oxlint-disable-next-line no-control-regex -- Deliberately recognize the only allowed terminal sequences.
  const sequences = /\x1b\[[0-9;:]*m|\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)/gu;
  let result = "";
  let position = 0;
  for (const match of text.matchAll(sequences)) {
    result += sanitizeOutput(text.slice(position, match.index));
    const target = match[1];
    if (target === undefined) {
      result += match[0];
    } else {
      result += `\x1b]8;;${target && isSafeExplicitUrl(target) ? target : ""}\x1b\\`;
    }
    position = match.index + match[0].length;
  }
  return result + sanitizeOutput(text.slice(position));
}

export function sanitizeRenderedLines(lines: readonly string[]): string[] {
  return lines.map(sanitizeRenderedOutput);
}

export function isSafeExplicitUrl(target: string): boolean {
  if (sanitizeOutput(target) !== target || /\s/u.test(target)) return false;
  try {
    const url = new URL(target);
    const protocol = url.protocol.toLowerCase();
    return (
      SAFE_URL_PROTOCOLS.has(protocol) &&
      (protocol !== "file:" ||
        ((url.hostname === "" || url.hostname.toLowerCase() === "localhost") &&
          url.username === "" &&
          url.password === ""))
    );
  } catch {
    return false;
  }
}
