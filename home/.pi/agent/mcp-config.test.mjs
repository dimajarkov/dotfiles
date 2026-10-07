import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

test("Composio keeps its synthetic API key out of child argv and sends it from the environment", async () => {
  const config = JSON.parse(readFileSync(join(repoRoot, "home/.pi/agent/mcp.json"), "utf8"));
  const serverConfig = config.mcpServers["composio-gmail"];
  const syntheticKey = "synthetic-composio-key-fixture";
  let receivedApiKey;
  const transport = createServer((request, response) => {
    receivedApiKey = request.headers["x-api-key"];
    response.writeHead(204);
    response.end();
  });

  await new Promise((resolveListen) => transport.listen(0, "127.0.0.1", resolveListen));
  const address = transport.address();
  assert.ok(address && typeof address !== "string");
  const localEndpoint = `http://127.0.0.1:${address.port}/mcp`;
  const temp = mkdtempSync(join(repoRoot, ".tmp-composio-config-test-"));

  try {
    const bin = join(temp, "bin");
    mkdirSync(bin);
    const infisicalPath = join(bin, "infisical");
    const npxPath = join(bin, "npx");
    const parserPath = join(temp, "mcp-remote-test-double.mjs");
    const scriptArgIndex = serverConfig.args.indexOf("-c") + 1;
    assert.ok(scriptArgIndex > 0);
    const args = [...serverConfig.args];
    args[scriptArgIndex] = args[scriptArgIndex].replace(
      /https:\/\/backend\.composio\.dev\/tool_router\/[^\s"]+/,
      localEndpoint,
    );
    assert.ok(args[scriptArgIndex].includes(localEndpoint));

    writeFileSync(
      infisicalPath,
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
    );
    writeFileSync(
      npxPath,
      '#!/bin/sh\n[ "$1" = "-y" ] || exit 31\nshift\n[ "$1" = "mcp-remote@0.1.38" ] || exit 32\nshift\nexec node "$MCP_REMOTE_TEST_DOUBLE" "$@"\n',
    );
    writeFileSync(
      parserPath,
      `const args = process.argv.slice(2);
const syntheticKey = process.env.COMPOSIO_API_KEY;
if (!syntheticKey || args.some((arg) => arg.includes(syntheticKey))) process.exit(41);
const headerIndex = args.indexOf("--header");
const header = args[headerIndex + 1];
const match = /^x-api-key:\\s*\\$\\{([A-Z_][A-Z0-9_]*)\\}$/.exec(header ?? "");
if (!match || args[0] !== ${JSON.stringify(localEndpoint)}) process.exit(42);
const response = await fetch(args[0], { headers: { "x-api-key": process.env[match[1]] } });
if (response.status !== 204) process.exit(43);
`,
    );
    chmodSync(infisicalPath, 0o755);
    chmodSync(npxPath, 0o755);

    const env = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: temp,
      COMPOSIO_API_KEY: syntheticKey,
      MCP_REMOTE_TEST_DOUBLE: parserPath,
    };
    const child = spawn(serverConfig.command, args, { cwd: repoRoot, env, stdio: "ignore" });
    let timeout;
    const exitCode = await Promise.race([
      new Promise((resolveExit) => child.once("close", resolveExit)),
      new Promise((_, rejectTimeout) => {
        timeout = setTimeout(() => {
          child.kill();
          rejectTimeout(new Error("configured Composio command timed out"));
        }, 5_000);
      }),
    ]).finally(() => clearTimeout(timeout));

    assert.equal(exitCode, 0, "configured command must keep the credential out of child argv");
    assert.equal(receivedApiKey, syntheticKey, "loopback transport must receive the configured header");
  } finally {
    await new Promise((resolveClose) => transport.close(resolveClose));
    rmSync(temp, { recursive: true, force: true });
  }
});
