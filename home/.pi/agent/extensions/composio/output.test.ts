import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { ComposioOutputStore, serialize } from "./output.js";

test("serialize handles bigint and cyclic results", () => {
  const value: { count: bigint; self?: unknown } = { count: 42n };
  value.self = value;
  assert.equal(serialize(value), '{\n  "count": "42",\n  "self": "[Circular]"\n}');
});

test("large results are truncated and stored in a private temporary file", () => {
  const store = new ComposioOutputStore();
  const value = { output: "x".repeat(60 * 1024) };
  const transformed = store.transform(value) as {
    outputFile: string;
  };

  assert.ok(transformed.outputFile);
  assert.equal(JSON.parse(readFileSync(transformed.outputFile, "utf8")).output, value.output);
  assert.match(store.format(transformed), /Output truncated/);
  assert.match(store.format(transformed), new RegExp(transformed.outputFile.replaceAll("/", "\\/")));

  store.cleanup();
  assert.equal(existsSync(transformed.outputFile), false);
});
