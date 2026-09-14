import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isSafeExplicitUrl, sanitizeOutput } from "../lib/terminal-safety.ts";

export {
  sanitizeMetadata,
  sanitizeOutput,
  sanitizeRenderedOutput,
} from "../lib/terminal-safety.ts";

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const LOCAL_FILE_EXTENSION = /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}(?::\d+(?::\d+)?)?(?:[#?].*)?$/u;
const MARKDOWN_LINK_START = /\[([^\]\n]+)\]\(/gu;
const INLINE_CODE = /`([^`\n]+)`/gu;
const BARE_URL = /(?<![A-Za-z0-9+./:-])(?:https?|file):\/\/[^\s<>"'`]+/giu;
const BARE_LOCAL_LINE_REFERENCE =
  /(?<![A-Za-z0-9_@./\\-])[A-Za-z0-9_@.-]+\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}:\d+(?::\d+)?(?![A-Za-z0-9_])/gu;
const PATH =
  /(^|[\s("'`])((?:\/[^\s<>"'`]+|~[\\/][^\s<>"'`]+|\.{1,2}[\\/][^\s<>"'`]+|[A-Za-z]:[\\/][^\s<>"'`]+|\\\\[^\s<>"'`]+|[A-Za-z0-9_@.-]+[\\/][^\s<>"'`]+))/gu;
const QUOTED_PATH = /(["'])((?:\/|~[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)[^"'`\n]+)\1/gu;

type LinkCandidate = {
  start: number;
  end: number;
  labelStart: number;
  labelEnd: number;
  href?: string;
  priority: number;
};

/**
 * Render a saved child result without summarizing or truncating it.
 *
 * The returned lines are ready for a modal body. Link activation is delegated to
 * Pi's OSC 8 handling and the terminal - this function never opens anything.
 */
export function renderOutputContent(text: string, cwd: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];

  const safeWidth = Math.max(1, Math.floor(width));
  const safeText = sanitizeOutput(text);
  return safeText.split("\n").flatMap((line) => {
    const linked = linkifyLine(line, cwd);
    return wrapTextWithAnsi(linked, safeWidth).map((wrapped) =>
      visibleWidth(wrapped) <= safeWidth ? wrapped : truncateToWidth(wrapped, safeWidth, ""),
    );
  });
}

function linkifyLine(line: string, cwd: string): string {
  const candidates = collectCandidates(line, cwd).sort(
    (left, right) =>
      left.start - right.start || left.priority - right.priority || right.end - left.end,
  );
  const selected: LinkCandidate[] = [];
  let occupiedUntil = -1;

  for (const candidate of candidates) {
    if (candidate.start < occupiedUntil) continue;
    selected.push(candidate);
    occupiedUntil = candidate.end;
  }

  let result = "";
  let position = 0;
  for (const candidate of selected) {
    result += line.slice(position, candidate.labelStart);
    if (candidate.href) {
      result += hyperlink(line.slice(candidate.labelStart, candidate.labelEnd), candidate.href);
    } else {
      result += line.slice(candidate.labelStart, candidate.labelEnd);
    }
    result += line.slice(candidate.labelEnd, candidate.end);
    position = candidate.end;
  }
  return result + line.slice(position);
}

function collectCandidates(line: string, cwd: string): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  collectMarkdownCandidates(line, cwd, candidates);
  collectInlineCodeCandidates(line, cwd, candidates);
  collectQuotedPathCandidates(line, cwd, candidates);
  collectRegexCandidates(line, BARE_URL, 2, candidates, (value) => hrefForTarget(value, cwd));
  collectRegexCandidates(line, BARE_LOCAL_LINE_REFERENCE, 2, candidates, (value) =>
    hrefForTarget(value, cwd),
  );
  collectPathCandidates(line, cwd, candidates);
  return candidates;
}

function collectMarkdownCandidates(line: string, cwd: string, candidates: LinkCandidate[]): void {
  MARKDOWN_LINK_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_LINK_START.exec(line)) !== null) {
    const openingEnd = match.index + match[0].length;
    let depth = 1;
    let end = openingEnd;
    const firstContent = openingEnd + (line.slice(openingEnd).match(/^\s*/u)?.[0].length ?? 0);
    let inAngleDestination = line[firstContent] === "<";
    for (; end < line.length; end++) {
      const character = line[end];
      const escaped = isMarkdownEscaped(line, end);
      if (inAngleDestination) {
        if (character === ">" && !escaped) inAngleDestination = false;
        continue;
      }
      if (escaped) continue;
      if (character === "(") depth++;
      if (character === ")" && --depth === 0) break;
    }
    if (depth !== 0) continue;

    const rawTarget = line.slice(openingEnd, end);
    const target = markdownTarget(rawTarget);
    const labelStart = match.index + 1;
    const labelEnd = labelStart + match[1]!.length;
    candidates.push({
      start: match.index,
      end: end + 1,
      labelStart,
      labelEnd,
      href: hrefForTarget(target, cwd, true),
      // An unsafe Markdown destination still occupies the whole link so a URL
      // embedded inside it cannot accidentally become an active nested link.
      priority: 0,
    });
    MARKDOWN_LINK_START.lastIndex = end + 1;
  }
}

function collectInlineCodeCandidates(line: string, cwd: string, candidates: LinkCandidate[]): void {
  INLINE_CODE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_CODE.exec(line)) !== null) {
    const value = match[1]!.trim();
    const start = match.index;
    const labelStart = start + 1 + (match[1]!.length - match[1]!.trimStart().length);
    const labelEnd = labelStart + value.length;
    candidates.push({
      start,
      end: match.index + match[0].length,
      labelStart,
      labelEnd,
      href:
        looksLikeLocalPath(value) || URL_SCHEME.test(value) ? hrefForTarget(value, cwd) : undefined,
      priority: 1,
    });
  }
}

function collectRegexCandidates(
  line: string,
  pattern: RegExp,
  priority: number,
  candidates: LinkCandidate[],
  toHref: (value: string) => string | undefined,
): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const value = trimTrailingPunctuation(match[0]);
    if (!value) continue;
    const start = match.index;
    candidates.push({
      start,
      end: start + value.length,
      labelStart: start,
      labelEnd: start + value.length,
      href: toHref(value),
      priority,
    });
  }
}

function collectQuotedPathCandidates(line: string, cwd: string, candidates: LinkCandidate[]): void {
  QUOTED_PATH.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_PATH.exec(line)) !== null) {
    const value = match[2]!;
    const labelStart = match.index + 1;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      labelStart,
      labelEnd: labelStart + value.length,
      href: hrefForTarget(value, cwd),
      priority: 1,
    });
  }
}

function collectPathCandidates(line: string, cwd: string, candidates: LinkCandidate[]): void {
  PATH.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH.exec(line)) !== null) {
    const prefix = match[1] ?? "";
    const rawValue = match[2]!;
    const value = trimTrailingPunctuation(rawValue);
    if (!value || !looksLikeLocalPath(value)) continue;
    const start = match.index + prefix.length;
    candidates.push({
      start,
      end: start + value.length,
      labelStart: start,
      labelEnd: start + value.length,
      href: hrefForTarget(value, cwd),
      priority: 3,
    });
  }
}

function markdownTarget(rawTarget: string): string {
  const target = rawTarget.trim();
  if (target.startsWith("<")) {
    const end = findUnescapedCharacter(target, ">", 1);
    if (end !== -1) return target.slice(1, end);
  }
  // Titles are separated by whitespace for URL destinations. Preserve spaces in
  // relative local paths, which are common in generated child output.
  if (URL_SCHEME.test(target)) return target.split(/\s+/u, 1)[0]!;
  const withTitle = target.match(/^(.+?)\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\))$/u);
  return withTitle?.[1] ?? target;
}

function hrefForTarget(rawTarget: string, cwd: string, markdownPath = false): string | undefined {
  const sourceTarget = rawTarget.trim();
  if (!sourceTarget || sourceTarget.startsWith("#")) return undefined;
  const target = markdownPath ? decodeMarkdownEscapes(sourceTarget) : sourceTarget;

  if (/^[A-Za-z]:[\\/]/u.test(target)) {
    return localFileHref(
      markdownPath ? decodeMarkdownPath(sourceTarget) : stripLineReference(target),
      cwd,
    );
  }

  if (URL_SCHEME.test(target)) {
    const referencedPath = stripLineReference(target);
    if (
      referencedPath !== target &&
      !URL_SCHEME.test(referencedPath) &&
      looksLikeLocalPath(referencedPath)
    ) {
      return localFileHref(markdownPath ? decodeMarkdownPath(sourceTarget) : referencedPath, cwd);
    }
    try {
      const url = new URL(target);
      const protocol = url.protocol.toLowerCase();
      if (!isSafeExplicitUrl(target)) return undefined;
      if (protocol === "file:") {
        let pathname = url.pathname;
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          // Preserve malformed percent escapes as literal filename text.
        }
        url.pathname = stripLineReference(pathname);
      }
      return url.href;
    } catch {
      return undefined;
    }
  }

  if (!markdownPath && !looksLikeLocalPath(target)) return undefined;
  if (target.startsWith("//")) return undefined;
  const path = markdownPath ? decodeMarkdownPath(sourceTarget) : stripLineReference(target);
  return localFileHref(path, cwd);
}

function stripLineReference(target: string): string {
  return target.replace(/:\d+(?::\d+)?$/u, "");
}

function decodeMarkdownPath(target: string): string {
  const suffix = findFirstUnescapedCharacter(target, new Set(["?", "#"]));
  const rawPathname = suffix === -1 ? target : target.slice(0, suffix);
  let pathname = rawPathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    // Preserve malformed percent escapes as literal filename text.
  }
  return decodeMarkdownEscapes(stripMarkdownLineReference(pathname));
}

function stripMarkdownLineReference(target: string): string {
  const match = /:\d+(?::\d+)?$/u.exec(target);
  return match && !isMarkdownEscaped(target, match.index) ? target.slice(0, match.index) : target;
}

function decodeMarkdownEscapes(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    const next = value[index + 1];
    if (character === "\\" && next !== undefined && /[!-/:-@[-`{-~]/u.test(next)) {
      result += next;
      index++;
    } else {
      result += character;
    }
  }
  return result;
}

function isMarkdownEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function findUnescapedCharacter(value: string, character: string, start = 0): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] === character && !isMarkdownEscaped(value, index)) return index;
  }
  return -1;
}

function findFirstUnescapedCharacter(value: string, characters: ReadonlySet<string>): number {
  for (let index = 0; index < value.length; index++) {
    if (characters.has(value[index]!) && !isMarkdownEscaped(value, index)) return index;
  }
  return -1;
}

function localFileHref(target: string, cwd: string): string | undefined {
  try {
    const expanded =
      target.startsWith("~/") || target.startsWith("~\\")
        ? `${homedir()}${target.slice(1)}`
        : target;
    const absolute =
      isAbsolute(expanded) || /^[A-Za-z]:[\\/]/u.test(expanded) ? expanded : resolve(cwd, expanded);
    const href = pathToFileURL(absolute).href;
    const fileAuthorityEnd = "file://".length;
    return `${href.slice(0, fileAuthorityEnd)}${href.slice(fileAuthorityEnd).replaceAll(":", "%3A")}`;
  } catch {
    return undefined;
  }
}

function looksLikeLocalPath(value: string): boolean {
  const target = value.trim();
  if (!target || target === "." || target === "..") return false;
  if (/^(?:\.{1,2}[\\/]|~[\\/]|[\\/]|[A-Za-z]:[\\/]|\\\\)/u.test(target)) return true;
  if (LOCAL_FILE_EXTENSION.test(target)) return true;
  return /[\\/]/u.test(target) && !/\s/u.test(target);
}

function trimTrailingPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && /[.,!?;:]/u.test(value[end - 1]!)) end--;

  while (end > 0) {
    const character = value[end - 1];
    if (character === ")" && count(value.slice(0, end), "(") < count(value.slice(0, end), ")")) {
      end--;
      continue;
    }
    if (character === "]" && count(value.slice(0, end), "[") < count(value.slice(0, end), "]")) {
      end--;
      continue;
    }
    if (character === "}" && count(value.slice(0, end), "{") < count(value.slice(0, end), "}")) {
      end--;
      continue;
    }
    break;
  }
  return value.slice(0, end);
}

function count(value: string, character: string): number {
  return [...value].filter((entry) => entry === character).length;
}
