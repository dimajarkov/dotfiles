import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// Development-only declaration emission. Main owns packaging the matching host API.
const source = process.argv[2];
if (!source || !isAbsolute(source) || !existsSync(source))
  throw new Error("Supply the pinned Hunk extension-api/types.ts absolute path");
const result = spawnSync(
  join(import.meta.dir, "node_modules/.bin/tsc"),
  [
    "--target",
    "ES2022",
    "--module",
    "ESNext",
    "--skipLibCheck",
    "--declaration",
    "--emitDeclarationOnly",
    "--outDir",
    resolve(import.meta.dir, ".host-types"),
    source,
  ],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
