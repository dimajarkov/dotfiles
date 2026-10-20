import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(root, "home/.local/bin/chrome-devtools-axi");

test("public launcher forwards arguments and exit status to the upstream CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "chrome launcher "));
  try {
    const backend = join(home, ".npm-global/bin/chrome-devtools-axi");
    mkdirSync(dirname(backend), { recursive: true });
    writeFileSync(backend, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n');
    chmodSync(backend, 0o700);
    for (const args of [
      ["snapshot"],
      ["open", "http://localhost:3000/path with spaces"],
      ["--help"],
    ]) {
      const result = spawnSync("/bin/sh", [launcher, ...args], {
        env: { HOME: home, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      assert.equal(result.status, 23);
      assert.equal(result.stdout, args.join("\n") + "\n");
      assert.equal(result.stderr, "");
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("missing upstream CLI fails without attempting installation or browser launch", () => {
  const home = mkdtempSync(join(tmpdir(), "chrome-launcher-missing-"));
  try {
    const result = spawnSync("/bin/sh", [launcher, "snapshot"], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /chrome-devtools-axi/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const adapter = join(root, "home/.local/bin/chrome-devtools-mcp-routing.mjs");

function withMcpFixture(help, run) {
  const fixtureHome = mkdtempSync(join(tmpdir(), "mcp routing "));
  const upstream = join(
    fixtureHome,
    ".npm-global/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
  );
  mkdirSync(dirname(upstream), { recursive: true });
  writeFileSync(
    upstream,
    `if (process.argv.includes("--help")) { console.log(${JSON.stringify(help)}); } else { console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 23; }`,
  );
  try {
    run(fixtureHome);
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
}

for (const [help, expectedFlag] of [
  ["  --experimentalPageIdRouting  expose page IDs", "--experimentalPageIdRouting=true"],
  ["  --pageIdRouting  route by page IDs [default: true]", "--pageIdRouting=true"],
]) {
  test(`adapter enables advertised routing without changing browser ownership: ${expectedFlag}`, () => {
    withMcpFixture(help, (fixtureHome) => {
      const args = [
        "--browserUrl=http://127.0.0.1:18999",
        "--userDataDir=/tmp/owned profile",
        "--chrome-arg=--use-mock-keychain",
      ];
      const result = spawnSync(process.execPath, [adapter, ...args], {
        env: { ...process.env, HOME: fixtureHome },
        encoding: "utf8",
      });
      assert.equal(result.status, 23);
      assert.deepEqual(JSON.parse(result.stdout), [...args, expectedFlag]);
      assert.equal(result.stderr, "");
    });
  });
}

test("adapter refuses an MCP with no advertised page routing rather than falling back to implicit selection", () => {
  withMcpFixture("  --browserUrl  connect to Chrome", (fixtureHome) => {
    const result = spawnSync(process.execPath, [adapter, "--browserUrl=http://127.0.0.1:18999"], {
      env: { ...process.env, HOME: fixtureHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 78);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /page.*routing/i);
  });
});

for (const argument of [
  "--experimentalPageIdRouting=false",
  "--no-page-id-routing",
  "--no-pageIdRouting",
  "--slim",
]) {
  test(`adapter fails closed on incompatible routing mode ${argument}`, () => {
    withMcpFixture("  --experimentalPageIdRouting expose page IDs", (fixtureHome) => {
      const result = spawnSync(process.execPath, [adapter, argument], {
        env: { ...process.env, HOME: fixtureHome },
        encoding: "utf8",
      });
      assert.equal(result.status, 78);
      assert.equal(result.stdout, "");
    });
  });
}

test("launcher selects the adapter only for its default local MCP and preserves explicit routes", () => {
  const fixtureHome = mkdtempSync(join(tmpdir(), "axi routing launcher "));
  try {
    const backend = join(fixtureHome, ".npm-global/bin/chrome-devtools-axi");
    mkdirSync(dirname(backend), { recursive: true });
    writeFileSync(
      backend,
      '#!/bin/sh\nprintf "%s\n" "${CHROME_DEVTOOLS_AXI_MCP_PATH-unset}" "${CHROME_DEVTOOLS_AXI_MCP_SERVER_URL-unset}" "${CHROME_DEVTOOLS_AXI_BROWSER_URL-unset}" "${CHROME_DEVTOOLS_AXI_SESSION-unset}"\n',
    );
    chmodSync(backend, 0o700);
    for (const [extra, expected] of [
      [{}, [adapter, "unset"]],
      [
        { CHROME_DEVTOOLS_AXI_MCP_PATH: "/explicit/compatible.mjs" },
        ["/explicit/compatible.mjs", "unset"],
      ],
      [
        { CHROME_DEVTOOLS_AXI_MCP_SERVER_URL: "http://127.0.0.1:19333/mcp" },
        ["unset", "http://127.0.0.1:19333/mcp"],
      ],
    ]) {
      const result = spawnSync("/bin/sh", [launcher, "snapshot"], {
        env: {
          HOME: fixtureHome,
          PATH: "/usr/bin:/bin",
          CHROME_DEVTOOLS_AXI_BROWSER_URL: "http://127.0.0.1:18999",
          CHROME_DEVTOOLS_AXI_SESSION: "owned-proof",
          ...extra,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split("\n"), [
        ...expected,
        "http://127.0.0.1:18999",
        "owned-proof",
      ]);
    }
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
});

test("adapter rejects separated false routing arguments", () => {
  withMcpFixture("  --experimentalPageIdRouting expose page IDs", (fixtureHome) => {
    const result = spawnSync(
      process.execPath,
      [adapter, "--experimental-page-id-routing", "false"],
      { env: { ...process.env, HOME: fixtureHome }, encoding: "utf8" },
    );
    assert.equal(result.status, 78);
    assert.equal(result.stdout, "");
  });
});

test("adapter help remains the upstream help without browser or routing startup", () => {
  withMcpFixture("upstream help", (fixtureHome) => {
    const result = spawnSync(process.execPath, [adapter, "--help"], {
      env: { ...process.env, HOME: fixtureHome },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "upstream help\n");
    assert.equal(result.stderr, "");
  });
});

test("Home Manager style symlink chains resolve the private adapter beside the source", () => {
  const fixtureHome = mkdtempSync(join(tmpdir(), "axi linked launcher "));
  try {
    const backend = join(fixtureHome, ".npm-global/bin/chrome-devtools-axi");
    const entry = join(fixtureHome, ".local/bin/chrome-devtools-axi");
    const middle = join(fixtureHome, "nix store launcher");
    mkdirSync(dirname(backend), { recursive: true });
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(backend, '#!/bin/sh\nprintf "%s\n" "$CHROME_DEVTOOLS_AXI_MCP_PATH"\n');
    chmodSync(backend, 0o700);
    symlinkSync(launcher, middle);
    symlinkSync(middle, entry);
    const result = spawnSync("/bin/sh", [entry, "snapshot"], {
      env: { HOME: fixtureHome, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), adapter);
  } finally {
    rmSync(fixtureHome, { recursive: true, force: true });
  }
});
