import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  AttachmentError,
  AXI_VERSION,
  MAX_TARGET_ORIGINS,
  prepareProfile,
  requestedNavigationTarget,
  requireAttachmentLifecycle,
  runAttachment,
} from "./browser-attachment.mjs";

const SESSION_PREFIX = "qa-";
const POLICY_VERSION = "1";
const AXI_ENV = "CHROME_DEVTOOLS_AXI_";
const POLICY_ENV = "DOTFILES_BROWSER_POLICY_";
const UNSAFE_ATTACH_FLAGS = new Set([
  "autoconnect",
  "browserurl",
  "channel",
  "chromearg",
  "chromeargs",
  "executablepath",
  "headless",
  "httpport",
  "isolated",
  "remotedebugging",
  "remotedebuggingport",
  "serverurl",
  "userdatadir",
  "wsendpoint",
]);
const ROUTING_GUIDANCE =
  "Chrome DevTools is opt-in for authorized repository/application QA only.\n" +
  "Use: chrome-devtools-axi --repo-qa <task-name> prepare-profile | attach <receipt> --pid <PID> --port <port> <bridge|Axi-command|stop|cleanup> [args...]\n" +
  "Run --help for supported commands and proof-target limitations.\n" +
  "Zen remains the personal browser. This guard is not an OS sandbox.\n";

const HELP =
  "Usage: chrome-devtools-axi [--help | --version]\n" +
  "       chrome-devtools-axi --repo-qa <task-name> prepare-profile [--target <HTTP-loopback-origin> ...]\n" +
  "       chrome-devtools-axi --repo-qa <task-name> attach <receipt> --pid <Chrome-PID> --port <CDP-port> <bridge|Axi-command|stop|cleanup> [args...]\n\n" +
  "No arguments print inert routing guidance. Standalone launch and setup are disabled.\n" +
  "The attach route connects only to externally owned Chrome verified against a\n" +
  "fresh signed task profile, exact live process/start/port, endpoint and Herdr binding.\n" +
  "Attached Axi commands use the pinned local chrome-devtools-axi command framework:\n" +
  "  open, snapshot, screenshot, click, fill, type, press, scroll, back, wait, eval, run,\n" +
  "  hover, drag, fillform, dialog, upload, pages, newpage, selectpage, closepage, resize,\n" +
  "  emulate, console, console-get, network, network-get, lighthouse, perf-start,\n" +
  "  perf-stop, perf-insight, heap. start and setup remain disabled.\n" +
  "Missing/dead bridges never auto-restart. Explicit open/newpage URLs must match\n" +
  "an origin declared by prepare-profile. Chrome pages are rechecked after commands;\n" +
  "bounded backend output is buffered and released only after ownership and proof-scope checks pass.\n" +
  "Declared origins define supported navigation and observed proof scope, not an\n" +
  "egress firewall. eval/run scripts, redirects, clicks, workers and network tools can\n" +
  "still issue requests outside those origins. Application auth, tenancy and operation\n" +
  "approval boundaries remain authoritative; direct executable bypasses are not contained.\n" +
  "Herdr requires the explicit attach route: prepare-profile creates an empty\n" +
  "0700 disposable profile and signed 0600 receipt without launching Chrome.\n" +
  "The repository runtime owner must launch installed stable Chrome with exactly:\n" +
  "  --user-data-dir=<allocated-profile> --remote-debugging-port=<CDP-port>\n" +
  "  --remote-debugging-address=127.0.0.1 --disable-sync --disable-extensions\n" +
  "  --use-mock-keychain --password-store=basic --no-first-run\n" +
  "  --no-default-browser-check about:blank\n" +
  "Optional: --headless=new. No other Chrome launch flags are supported.\n" +
  "Chrome must start within 10 minutes of preparation; the allocation expires\n" +
  "after 2 hours and supports one foreground bridge and one live Chrome PID/start.\n" +
  "Endpoint identity accepts about:blank and allocated HTTP loopback origins.\n" +
  "Target-origin checks are metadata checks, not enforced network containment.\n" +
  "Repeat --target for multiple origins in this same profile (maximum 8).\n" +
  "Without --target, only about:blank is accepted. localhost is also supported.\n" +
  "Run attach ... bridge synchronously in an ordinary Herdr proof shell at the\n" +
  "physical Git root. Its verified lifecycle remains owned by that workspace.\n" +
  "attach ... stop closes only the verified bridge, retaining externally owned\n" +
  "Chrome. Its runtime owner closes Chrome; attach ... cleanup then removes\n" +
  "only the exact allocated profile after kernel absence/listener/user checks.\n" +
  "Failed proof locks and inconclusive inspection retain resources; recovery\n" +
  "requires a fresh allocation. Attach requires macOS, signed stable Chrome,\n" +
  "exact live Herdr metadata and Node module.registerHooks support.\n" +
  "Scoped attach/preparation neutralize inherited EXECUTABLE_PATH, HEADED and\n" +
  "PLAYWRIGHT_BROWSERS_PATH controls. Other transport/runtime overrides must\n" +
  "be cleared for this invocation; global settings are never changed.\n" +
  "The shell wrapper neutralizes NODE_OPTIONS and NODE_PATH before Node starts.\n" +
  "Do not expose tokens or session data. External writes\n" +
  "require explicit authorization.\n";

class PolicyError extends Error {}

function reject(message) {
  throw new PolicyError(message);
}

function isHelp(args) {
  return args.includes("--help") || args.includes("-h");
}

function isVersion(args) {
  return args.includes("--version") || args.includes("-v") || args.includes("-V");
}

function checkEnvironment(scopedAttach = false) {
  const hasUnsafeControl = Object.keys(process.env).some((name) => {
    if (
      scopedAttach &&
      [
        "CHROME_DEVTOOLS_AXI_EXECUTABLE_PATH",
        "CHROME_DEVTOOLS_AXI_HEADED",
        "PLAYWRIGHT_BROWSERS_PATH",
      ].includes(name)
    )
      return false;
    return (
      name.startsWith(AXI_ENV) ||
      name.startsWith("CHROME_DEVTOOLS_MCP_") ||
      name.startsWith("PUPPETEER_") ||
      name.startsWith("PLAYWRIGHT_") ||
      /^npm_config_/i.test(name) ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "BROWSER",
        "CHROME_BIN",
        "CHROMIUM_BIN",
        "GOOGLE_CHROME_SHIM",
        "CHROME_PATH",
        "CHROME_EXECUTABLE",
        "DEBUG",
        "NODE_DEBUG",
      ].includes(name)
    );
  });

  if (hasUnsafeControl) {
    reject("browser transport/runtime overrides are set; clear them before repository QA");
  }
  if (/\s/.test(process.execPath)) {
    reject("the Node executable path contains unsupported whitespace");
  }
}

function parseRequest(args) {
  if (args[0] !== "--repo-qa") {
    reject("explicit repository QA intent is required; use --repo-qa <task-name>");
  }

  if (args.length < 3) {
    reject("usage: chrome-devtools-axi --repo-qa <task-name> <command> [args...]");
  }

  const task = args[1];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(task)) {
    reject("task name must be 1-32 letters, digits, dots, underscores, or dashes");
  }

  const command = args[2];
  if (command === "prepare-profile") {
    const targets = [];
    for (let index = 3; index < args.length; index += 2) {
      if (args[index] !== "--target" || index + 1 >= args.length)
        reject("prepare-profile accepts only repeated --target <HTTP-loopback-origin> options");
      if (targets.length === MAX_TARGET_ORIGINS)
        reject(`prepare-profile accepts at most ${MAX_TARGET_ORIGINS} loopback target origins`);
      targets.push(args[index + 1]);
    }
    return { task, command, targets };
  }
  if (command === "attach") {
    if (
      args[4] !== "--pid" ||
      args[6] !== "--port" ||
      !/^[1-9][0-9]*$/.test(args[5] || "") ||
      !/^[1-9][0-9]*$/.test(args[7] || "") ||
      Number(args[7]) > 65535
    )
      reject("attach requires a receipt, --pid <PID>, --port <CDP-port>, and command");
    const attached = args[8];
    requireAttachmentLifecycle(attached);
    const commandArgs = args.slice(9);
    if (["bridge", "stop", "cleanup"].includes(attached) && commandArgs.length)
      reject("bridge, stop and cleanup accept no additional arguments");
    if (["open", "newpage"].includes(attached) && !requestedNavigationTarget(attached, commandArgs))
      reject(`${attached} requires an explicit URL`);
    const unsafeFlag = commandArgs.some((value) => {
      if (!value.startsWith("--")) return false;
      const name = value.split("=", 1)[0].toLowerCase().replaceAll("-", "");
      return UNSAFE_ATTACH_FLAGS.has(name);
    });
    if (unsafeFlag) reject("browser transport and profile flags are not supported");
    return {
      task,
      command: attached,
      receipt: args[3],
      pid: Number(args[5]),
      cdpPort: Number(args[7]),
      commandArgs,
    };
  }
  reject(
    "standalone browser modes are disabled; use prepare-profile and explicit foreground Herdr attach",
  );
}

function physicalRepositoryRoot() {
  let path;
  try {
    path = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return realpathSync.native(path);
  } catch {
    reject("run repository QA from inside a Git working tree");
  }
}

function physicalHome() {
  if (!process.env.HOME || !process.env.HOME.startsWith("/")) {
    reject("a physical HOME directory is required for repository QA");
  }
  try {
    const home = realpathSync.native(process.env.HOME);
    const stats = lstatSync(home);
    if (!stats.isDirectory() || stats.uid !== currentUid() || (stats.mode & 0o022) !== 0) {
      reject("the HOME directory has unsafe ownership or permissions");
    }
    return home;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    reject("the HOME directory could not be verified");
  }
}

function currentUid() {
  if (typeof process.getuid !== "function") {
    reject("this guarded route requires a process-UID inspection API");
  }
  return process.getuid();
}

function checkedLocalScript(path, expectedUid) {
  try {
    const realPath = realpathSync.native(path);
    const stats = lstatSync(path);
    if (
      /\s/.test(realPath) ||
      !stats.isFile() ||
      stats.uid !== expectedUid ||
      (stats.mode & 0o022) !== 0
    ) {
      reject("a pinned local browser script could not be verified");
    }
    return realPath;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    reject("a pinned local browser script is unavailable or unsafe");
  }
}

function checkedPackage(home, name, expectedVersion, entry) {
  const globalRoot = join(home, ".npm-global", "lib", "node_modules");
  const packageRoot = join(globalRoot, name);
  const packageFile = join(packageRoot, "package.json");
  const entryFile = join(packageRoot, entry);

  try {
    const realGlobalRoot = realpathSync.native(globalRoot);
    const realPackageRoot = realpathSync.native(packageRoot);
    const realEntry = realpathSync.native(entryFile);
    if (!realPackageRoot.startsWith(`${realGlobalRoot}/`)) {
      reject("the pinned local browser package is outside the audited npm owner");
    }

    const packageDirectories = [
      home,
      join(home, ".npm-global"),
      join(home, ".npm-global", "lib"),
      globalRoot,
      packageRoot,
    ];
    for (
      let directory = dirname(entryFile);
      directory.startsWith(`${packageRoot}/`);
      directory = dirname(directory)
    ) {
      packageDirectories.push(directory);
    }
    for (const directory of packageDirectories) {
      const stats = lstatSync(directory);
      if (!stats.isDirectory() || stats.uid !== currentUid() || (stats.mode & 0o022) !== 0) {
        reject(`the pinned local ${name} package directory is unsafe`);
      }
    }

    const metadataStats = lstatSync(packageFile);
    if (
      !metadataStats.isFile() ||
      metadataStats.uid !== currentUid() ||
      (metadataStats.mode & 0o022) !== 0
    ) {
      reject(`the pinned local ${name} package metadata could not be verified`);
    }
    const metadata = JSON.parse(readFileSync(packageFile, "utf8"));
    if (metadata.name !== name || metadata.version !== expectedVersion) {
      reject(`the pinned local ${name} version is not ${expectedVersion}`);
    }
    if (realEntry !== checkedLocalScript(entryFile, currentUid())) {
      reject(`the pinned local ${name} executable could not be verified`);
    }
    return realEntry;
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    reject(`the pinned local ${name} package is unavailable or unsafe`);
  }
}

function makeIdentity(home, repo, task) {
  const repoHash = createHash("sha256").update(repo).digest("hex").slice(0, 12);
  const session = `${SESSION_PREFIX}${repoHash}-${task}`;
  let portHash = 2166136261;
  for (const character of session) {
    portHash ^= character.charCodeAt(0);
    portHash = Math.imul(portHash, 16777619);
  }
  const port = 9225 + (Math.abs(portHash) % 1000);
  const stateDir = join(home, ".chrome-devtools-axi", "sessions", session);
  return { repoHash, session, port, stateDir };
}

function checkOwnedDirectory(path) {
  try {
    const stats = lstatSync(path);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      stats.uid !== currentUid() ||
      (stats.mode & 0o022) !== 0
    ) {
      reject("browser session state has unsafe ownership or permissions");
    }
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    if (error instanceof PolicyError) throw error;
    reject("browser session state could not be verified");
  }
}

function stateExists(home, stateDir) {
  const base = join(home, ".chrome-devtools-axi");
  const sessions = join(base, "sessions");
  if (!checkOwnedDirectory(base)) return false;
  if (!checkOwnedDirectory(sessions)) return false;
  return checkOwnedDirectory(stateDir);
}

function checkedPidInfo(stateDir, expectedPort) {
  const pidPath = join(stateDir, "bridge.pid");
  try {
    const stats = lstatSync(pidPath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.uid !== currentUid() ||
      (stats.mode & 0o022) !== 0
    ) {
      reject("browser session PID state has unsafe ownership or permissions");
    }
    const value = JSON.parse(readFileSync(pidPath, "utf8"));
    if (!Number.isInteger(value.pid) || value.pid < 1 || value.port !== expectedPort) {
      reject("browser session PID state does not match this repository task");
    }
    return { pid: value.pid, port: value.port };
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    reject("browser session is stale or has unreadable PID state; choose a new task name");
  }
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

function buildBackendEnvironment(home, identity, repoHash, mcpPath) {
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) {
    if (name.startsWith(AXI_ENV) || name.startsWith(POLICY_ENV)) delete env[name];
  }
  env.PATH = `${dirname(process.execPath)}${delimiter}${env.PATH || "/usr/bin:/bin"}`;
  env[`${AXI_ENV}SESSION`] = identity.session;
  env[`${AXI_ENV}PORT`] = String(identity.port);
  env[`${AXI_ENV}MCP_PATH`] = mcpPath;
  env[`${POLICY_ENV}SESSION`] = identity.session;
  env[`${POLICY_ENV}REPO_SHA256`] = repoHash;
  env[`${POLICY_ENV}VERSION`] = POLICY_VERSION;
  return env;
}

async function runQa(args) {
  const scopedAttach = ["prepare-profile", "attach"].includes(args[2]);
  checkEnvironment(scopedAttach);
  const request = parseRequest(args);
  const home = physicalHome();
  const repo = physicalRepositoryRoot();
  if (request.command === "prepare-profile") {
    process.stdout.write(
      `${JSON.stringify(prepareProfile(home, repo, request.task, request.targets))}\n`,
    );
    return 0;
  }
  if (request.receipt) {
    return runAttachment(home, repo, request, {
      checkedPackage,
      checkedLocalScript,
      makeIdentity,
      buildBackendEnvironment,
      stateExists,
      checkedPidInfo,
      isPortAvailable,
    });
  }
  reject("standalone browser modes are disabled; use explicit foreground Herdr attach");
}

async function main(args) {
  if (args.length === 0) {
    process.stdout.write(ROUTING_GUIDANCE);
    return 0;
  }

  if (isHelp(args)) {
    process.stdout.write(HELP);
    return 0;
  }

  if (isVersion(args)) {
    process.stdout.write(`chrome-devtools-axi ${AXI_VERSION} (guarded)\n`);
    return 0;
  }

  try {
    return await runQa(args);
  } catch (error) {
    const message =
      error instanceof PolicyError || error instanceof AttachmentError
        ? error.message
        : "browser policy validation failed; no browser command was run";
    process.stderr.write(`chrome-devtools-axi: ${message}\n`);
    return 78;
  }
}

if (process.argv[1] && realpathSync.native(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
