import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";

interface TruncatedComposioResult {
  __piComposioTruncated: true;
  preview: string;
  outputFile: string;
  totalBytes: number;
  totalLines: number;
}

function isTruncatedResult(value: unknown): value is TruncatedComposioResult {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Partial<TruncatedComposioResult>).__piComposioTruncated === true
  );
}

export function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item !== null && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    },
    2,
  );
  return serialized ?? String(value);
}

export class ComposioOutputStore {
  private directory?: string;
  private nextFile = 1;

  transform(value: unknown): unknown {
    const serialized = serialize(value);
    const truncation = truncateHead(serialized, {
      maxBytes: DEFAULT_MAX_BYTES,
      maxLines: DEFAULT_MAX_LINES,
    });
    if (!truncation.truncated) return value;

    this.directory ??= mkdtempSync(join(tmpdir(), "pi-composio-"));
    chmodSync(this.directory, 0o700);
    const outputFile = join(this.directory, `result-${this.nextFile++}.json`);
    writeFileSync(outputFile, serialized, { encoding: "utf8", mode: 0o600 });

    return {
      __piComposioTruncated: true,
      preview: truncation.content,
      outputFile,
      totalBytes: truncation.totalBytes,
      totalLines: truncation.totalLines,
    } satisfies TruncatedComposioResult;
  }

  format(value: unknown): string {
    if (!isTruncatedResult(value)) return serialize(value);
    return `${value.preview}\n\n[Output truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} from ${value.totalLines} lines (${formatSize(value.totalBytes)}). Full output saved to: ${value.outputFile}]`;
  }

  cleanup(): void {
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
    this.directory = undefined;
    this.nextFile = 1;
  }
}
