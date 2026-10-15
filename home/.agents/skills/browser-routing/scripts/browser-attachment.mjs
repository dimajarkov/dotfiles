import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import * as nodeModule from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class AttachmentError extends Error {}
export const MAX_TARGET_ORIGINS = 8;
export const AXI_VERSION = "0.1.35";
export const MCP_VERSION = "1.6.0";
const BRIDGE_NAME = "chrome-devtools-axi-bridge.js";
const BASE_ENV_KEYS = [
  "HOME",
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
  "HERDR_ENV",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
];
function scopedEnvironment(env) {
  return Object.fromEntries(
    BASE_ENV_KEYS.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  );
}
export function refuse(message) {
  throw new AttachmentError(message);
}

const ATTACHED_COMMANDS = new Set([
  "open",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "type",
  "press",
  "scroll",
  "back",
  "wait",
  "eval",
  "run",
  "hover",
  "drag",
  "fillform",
  "dialog",
  "upload",
  "pages",
  "newpage",
  "selectpage",
  "closepage",
  "resize",
  "emulate",
  "console",
  "console-get",
  "network",
  "network-get",
  "lighthouse",
  "perf-start",
  "perf-stop",
  "perf-insight",
  "heap",
  "bridge",
  "stop",
  "cleanup",
  "diagnose",
]);
const MAX_BACKEND_OUTPUT_BYTES = 256_000;

export function requireAttachmentLifecycle(command) {
  if (!ATTACHED_COMMANDS.has(command))
    refuse("unsupported attached Axi command; standalone launch and setup are disabled");
}

export function requestedNavigationTarget(command, args = []) {
  if (command === "open") return args[0];
  if (command === "newpage") return args.find((argument) => !argument.startsWith("--"));
  return undefined;
}

function privatePath(path, directory) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    (stat.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    realpathSync.native(path) !== path
  )
    refuse("allocation ownership, mode, or canonical path is unsafe");
  return stat;
}

function privateRead(path) {
  const before = privatePath(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size > 65536
    )
      refuse("allocation file identity changed");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function allocationRoot(home, create = false) {
  const base = join(home, ".chrome-devtools-axi");
  if (create) {
    try {
      mkdirSync(base, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const stat = lstatSync(base);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o022 ||
    realpathSync.native(base) !== base
  )
    refuse("browser allocation parent is unsafe");
  const root = join(base, "qa-allocations");
  if (create) {
    try {
      mkdirSync(root, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  privatePath(root, true);
  return root;
}

function allocationKey(root, create = false) {
  const path = join(root, "key");
  if (create) {
    try {
      writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const key = privateRead(path);
  if (key.length !== 32) refuse("allocation provenance key is invalid");
  return key;
}

function signature(value, key) {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function saveReceipt(path, value, key) {
  privatePath(dirname(path), true);
  privatePath(dirname(dirname(path)), true);
  const temporary = join(dirname(path), `.write-${randomBytes(16).toString("hex")}`);
  writeFileSync(temporary, JSON.stringify({ value, signature: signature(value, key) }), {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function targetOrigin(target) {
  if (
    typeof target !== "string" ||
    !/^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]+\/?$/i.test(target)
  ) {
    refuse("target must be an exact HTTP loopback origin with an explicit port");
  }
  try {
    const url = new URL(target);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(url.hostname) ||
      !url.port ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      refuse("target must be an exact HTTP loopback origin with an explicit port");
    return url.origin;
  } catch {
    refuse("target must be an exact HTTP loopback origin with an explicit port");
  }
}

function targetOrigins(targets) {
  if (!Array.isArray(targets) || targets.length > MAX_TARGET_ORIGINS)
    refuse(`prepare-profile accepts at most ${MAX_TARGET_ORIGINS} loopback target origins`);
  const origins = targets.map(targetOrigin);
  if (new Set(origins).size !== origins.length) refuse("target origins must be unique");
  return origins;
}

export function allowedTarget(url, origins) {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    return Boolean(
      Array.isArray(origins) &&
      origins.includes(parsed.origin) &&
      !parsed.username &&
      !parsed.password,
    );
  } catch {
    return false;
  }
}

export function prepareProfile(home, repo, task, targets) {
  const origins = targetOrigins(targets);
  const root = allocationRoot(home, true);
  const key = allocationKey(root, true);
  const token = randomBytes(16).toString("hex");
  const directory = join(root, token);
  mkdirSync(directory, { mode: 0o700 });
  const profile = join(directory, "profile");
  mkdirSync(profile, { mode: 0o700 });
  const stat = privatePath(profile, true);
  const receipt = join(directory, "receipt.json");
  const created = Date.now();
  saveReceipt(
    receipt,
    {
      version: 2,
      token,
      uid: process.getuid(),
      repo,
      task,
      profile,
      origins,
      dev: stat.dev,
      ino: stat.ino,
      created,
      expires: created + 2 * 60 * 60 * 1000,
      binding: null,
      closed: false,
    },
    key,
  );
  return { receipt, profile, expires: new Date(created + 2 * 60 * 60 * 1000).toISOString() };
}

export function readAllocation(home, repo, task, receipt, allowExpired = false) {
  try {
    const root = allocationRoot(home);
    const token = basename(dirname(receipt));
    if (!/^[a-f0-9]{32}$/.test(token) || receipt !== join(root, token, "receipt.json"))
      refuse("receipt is outside the guard allocation registry");
    privatePath(dirname(receipt), true);
    const key = allocationKey(root);
    const signed = JSON.parse(privateRead(receipt));
    const value = signed.value;
    if (
      typeof signed.signature !== "string" ||
      !/^[a-f0-9]{64}$/.test(signed.signature) ||
      !timingSafeEqual(Buffer.from(signed.signature), Buffer.from(signature(value, key)))
    )
      refuse("receipt has no guard-created allocation provenance");
    if (value.version !== 2)
      refuse("allocation receipt schema is unsupported; prepare a fresh profile");
    if (
      value.token !== token ||
      value.uid !== process.getuid() ||
      value.repo !== repo ||
      value.task !== task ||
      value.profile !== join(root, token, "profile")
    )
      refuse("allocation does not belong to this repository, task, or UID");
    if (
      !Number.isSafeInteger(value.created) ||
      value.created > Date.now() ||
      value.expires !== value.created + 7200000 ||
      (!allowExpired && (Date.now() > value.expires || value.closed)) ||
      JSON.stringify(targetOrigins(value.origins)) !== JSON.stringify(value.origins)
    )
      refuse("allocation is stale or retired; prepare a fresh profile");
    const stat = privatePath(value.profile, true);
    if (stat.dev !== value.dev || stat.ino !== value.ino)
      refuse("allocated profile identity changed");
    return { value, key, receipt };
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    refuse("allocation receipt or profile could not be safely verified");
  }
}

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REQUIRED_CHROME_FLAGS = [
  "--disable-sync",
  "--disable-extensions",
  "--use-mock-keychain",
  "--password-store=basic",
  "--no-first-run",
  "--no-default-browser-check",
];

// A deliberately small launch contract. Unknown switches are refused rather
// than trying to maintain a denylist of Chromium's security/profile switches.
export function validateChromeRecord(record, value, pid, port) {
  if (
    !record ||
    record.pid !== pid ||
    record.uid !== value.uid ||
    record.exe !== CHROME ||
    record.argv?.[0] !== CHROME ||
    !/^\d+:\d+$/.test(record.start || "")
  )
    refuse("Chrome executable, UID, or process identity is unverified");
  const started =
    Number(record.start.split(":")[0]) * 1000 + Number(record.start.split(":")[1]) / 1000;
  if (started < value.created || started > value.created + 600000)
    refuse("Chrome did not start within this fresh allocation window");
  const flags = [
    ...REQUIRED_CHROME_FLAGS,
    `--user-data-dir=${value.profile}`,
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
  ];
  const required = new Set(flags);
  let targets = 0;
  for (const arg of record.argv.slice(1)) {
    if (required.delete(arg)) continue;
    // Fixed QA startup setting only; arbitrary feature overrides stay refused.
    if (arg === "--disable-features=PreloadTopChromeWebUI" && !flags.includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (arg === "--headless=new" && !flags.includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (arg === "about:blank" && ++targets === 1) continue;
    refuse("actual Chrome argv contains an unsupported launch, profile, or target override");
  }
  if (required.size || targets !== 1)
    refuse("actual Chrome argv lacks the required isolation flags and blank target");
  if (
    value.binding &&
    (value.binding.pid !== pid ||
      value.binding.port !== port ||
      value.binding.start !== record.start)
  )
    refuse("allocation is bound to another process or a reused PID");
  return { pid, port, start: record.start };
}

function inspector() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "browser-inspect.py");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o022)
    refuse("OS inspection helper is unsafe");
  return (operation, ...args) => {
    try {
      return JSON.parse(
        execFileSync("/usr/bin/python3", ["-I", path, operation, ...args.map(String)], {
          encoding: "utf8",
          env: scopedEnvironment(process.env),
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        }),
      );
    } catch {
      refuse("exact macOS process inspection failed or is unsupported");
    }
  };
}

export function validateListener(listeners, pid, port) {
  if (
    !Array.isArray(listeners) ||
    listeners.length !== 1 ||
    listeners[0].pid !== pid ||
    listeners[0].address !== `127.0.0.1:${port}`
  )
    refuse("loopback listener does not belong exclusively to the verified process");
}

async function readJson(url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1500) });
    if (response.status !== 200) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 256000) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    refuse("owned loopback endpoint failed a bounded metadata probe");
  }
}

function validateVersion(version, port) {
  let ws;
  try {
    ws = new URL(version.webSocketDebuggerUrl);
  } catch {
    refuse("owned Chrome endpoint has invalid browser transport metadata");
  }
  if (
    !(version.Browser || "").startsWith("Chrome/") ||
    ws.protocol !== "ws:" ||
    ws.hostname !== "127.0.0.1" ||
    ws.port !== String(port) ||
    ws.username ||
    ws.password ||
    ws.search ||
    ws.hash ||
    !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(ws.pathname)
  )
    refuse("owned Chrome endpoint points to a foreign browser transport");
}

export function validateEndpoint(version, pages, port, origins) {
  validateVersion(version, port);
  if (targetSummary(pages, origins).status !== "ready")
    refuse("owned Chrome contains a foreign or non-synthetic target; no page metadata was emitted");
}

function targetSummary(pages, origins) {
  const counts = {
    permitted_page: 0,
    permitted_worker: 0,
    internal_page: 0,
    internal_non_page: 0,
    foreign_target: 0,
    unsupported_type: 0,
    malformed_target: 0,
  };
  if (!Array.isArray(pages)) return { status: "blocked", reason: "invalid_list", counts };
  for (const page of pages) {
    if (!page || typeof page.type !== "string" || typeof page.url !== "string") {
      counts.malformed_target++;
      continue;
    }
    const supported = ["page", "service_worker", "worker"].includes(page.type);
    if (supported && allowedTarget(page.url, origins)) {
      counts[page.type === "page" ? "permitted_page" : "permitted_worker"]++;
    } else if (
      [
        "page",
        "service_worker",
        "worker",
        "other",
        "browser",
        "tab",
        "iframe",
        "background_page",
        "shared_worker",
      ].includes(page.type) &&
      /^(chrome:|chrome-untrusted:|devtools:|about:)/.test(page.url)
    ) {
      // Classification only. Internal URLs and every unsupported type still
      // refuse proof; no Chromium-internal allowlist is inferred from counts.
      counts[page.type === "page" ? "internal_page" : "internal_non_page"]++;
    } else if (!supported) {
      counts.unsupported_type++;
    } else {
      counts.foreign_target++;
    }
  }
  const rejected = Object.entries(counts).some(
    ([key, count]) => !key.startsWith("permitted_") && count,
  );
  const reason = rejected ? "scope_refused" : counts.permitted_page ? "ready" : "missing_page";
  return { status: reason === "ready" ? "ready" : "blocked", reason, counts };
}

// Diagnostic vocabulary only. Raw target types never become output keys.
const DIAGNOSTIC_TARGET_TYPES = [
  "page",
  "service_worker",
  "worker",
  "other",
  "browser",
  "tab",
  "iframe",
  "background_page",
  "shared_worker",
  "browser_ui",
  "worklet",
  "webview",
  "auction_worklet",
  "assistive_technology",
  "app",
  "unknown",
];

function rejectedTypeCounts(pages, origins) {
  const empty = () => Object.fromEntries(DIAGNOSTIC_TARGET_TYPES.map((type) => [type, 0]));
  const output = { unsupported_type: empty(), foreign_target: empty() };
  if (!Array.isArray(pages)) return output;
  for (const page of pages) {
    // Reuse the unchanged classifier; diagnostics cannot expand admission.
    const counts = targetSummary([page], origins).counts;
    const category = counts.unsupported_type
      ? "unsupported_type"
      : counts.foreign_target
        ? "foreign_target"
        : undefined;
    if (!category) continue;
    const type = DIAGNOSTIC_TARGET_TYPES.includes(page.type) ? page.type : "unknown";
    output[category][type]++;
  }
  return output;
}

function chromeOwnership(inspect, allocation, request, observed) {
  const before = observed ?? inspect("record", request.pid);
  const binding = validateChromeRecord(before, allocation.value, request.pid, request.cdpPort);
  if (inspect("trusted-chrome") !== true)
    refuse("installed Chrome signature could not be verified");
  validateListener(inspect("listeners", request.cdpPort), request.pid, request.cdpPort);
  return { before, binding };
}

function recheckChromeOwnership(inspect, allocation, request, before) {
  const after = inspect("record", request.pid);
  validateChromeRecord(after, allocation.value, request.pid, request.cdpPort);
  if (after.start !== before.start || JSON.stringify(after.argv) !== JSON.stringify(before.argv))
    refuse("Chrome process changed during inspection");
  validateListener(inspect("listeners", request.cdpPort), request.pid, request.cdpPort);
}

async function verifyChrome(inspect, allocation, request) {
  const { before, binding } = chromeOwnership(inspect, allocation, request);
  const url = `http://127.0.0.1:${request.cdpPort}`;
  // No endpoint, including /json/version, is read before the kernel checks.
  const version = await readJson(`${url}/json/version`);
  validateVersion(version, request.cdpPort);
  const pages = await readJson(`${url}/json/list`);
  validateEndpoint(version, pages, request.cdpPort, allocation.value.origins);
  recheckChromeOwnership(inspect, allocation, request, before);
  return binding;
}

function assertAllocationCurrent(home, allocation, request) {
  const current = readAllocation(home, allocation.value.repo, request.task, request.receipt, true);
  if (JSON.stringify(current.value) !== JSON.stringify(allocation.value))
    refuse("allocation changed during diagnosis; resources retained");
}

function assertCallerCurrent(inspect, repo, caller) {
  const current = callerContext(inspect, repo, false);
  if (JSON.stringify(current) !== JSON.stringify(caller))
    refuse("Herdr caller context changed during diagnosis; resources retained");
}

function assertCallerWorkspace(allocation, caller) {
  const binding = allocation.value.binding;
  const workspace = binding?.owner?.workspace;
  if (
    binding === undefined ||
    (binding !== null && (!/^w[A-Za-z0-9]+$/.test(workspace || "") || !binding.owner))
  )
    refuse("allocation foreground bridge owner workspace is invalid");
  if (binding !== null && caller.workspace !== workspace)
    refuse("caller is outside the foreground bridge's owned Herdr workspace");
}

function assertRequestedProcessAbsent(inspect, request) {
  if (inspect("record", request.pid) !== null)
    refuse("requested process is live or its PID was reused; inventory not reported");
}

function assertRequestedListenerEmpty(inspect, request) {
  const listeners = inspect("listeners", request.cdpPort);
  if (!Array.isArray(listeners) || listeners.length)
    refuse("requested loopback port has a listener; inventory not reported");
}

function readInventoryDiagnostic(inspect, profile) {
  let report;
  try {
    report = inspect("profile-users-summary", profile);
  } catch {
    // Failure to run the bounded inspector is unknown, never zero users.
  }
  return report === undefined
    ? {
        status: "incomplete",
        counts: null,
        failures: [{ stage: "inspector", reason: "unavailable", errno: null, count: 1 }],
      }
    : inventorySummary(report);
}

async function diagnoseAfterChromeExit(home, inspect, allocation, request, caller) {
  assertAllocationCurrent(home, allocation, request);
  assertRequestedProcessAbsent(inspect, request);
  assertRequestedListenerEmpty(inspect, request);

  let inventory;
  let inventoryError;
  try {
    inventory = readInventoryDiagnostic(inspect, allocation.value.profile);
  } catch (error) {
    inventoryError = error;
  }

  // Re-probe absence after inventory, even when the summary itself is unusable.
  assertRequestedProcessAbsent(inspect, request);
  assertRequestedListenerEmpty(inspect, request);
  assertCallerCurrent(inspect, allocation.value.repo, caller);
  assertAllocationCurrent(home, allocation, request);
  if (inventoryError) throw inventoryError;

  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      process: { requested_pid_absent: true },
      listener: { requested_port_empty: true },
      targets: { status: "not_observed", initial_target: "not_proven" },
      inventory,
    })}\n`,
  );
  return 0;
}

async function diagnose(home, inspect, allocation, request, caller) {
  const observed = inspect("record", request.pid);
  if (observed === null) return diagnoseAfterChromeExit(home, inspect, allocation, request, caller);

  const { before } = chromeOwnership(inspect, allocation, request, observed);
  const url = `http://127.0.0.1:${request.cdpPort}`;
  const version = await readJson(`${url}/json/version`);
  validateVersion(version, request.cdpPort);
  const pages = await readJson(`${url}/json/list`);
  const targets = targetSummary(pages, allocation.value.origins);
  const inventory = readInventoryDiagnostic(inspect, allocation.value.profile);
  recheckChromeOwnership(inspect, allocation, request, before);
  assertCallerCurrent(inspect, allocation.value.repo, caller);
  assertAllocationCurrent(home, allocation, request);
  process.stdout.write(
    `${JSON.stringify({
      version: 1,
      ownership: "verified",
      targets: {
        ...targets,
        rejected_type_counts: rejectedTypeCounts(pages, allocation.value.origins),
      },
      inventory,
    })}\n`,
  );
  return 0;
}

function inventorySummary(report) {
  const stages = [
    "inventory_platform",
    "inventory_list",
    "bsdinfo",
    "procargs_size",
    "procargs_read",
    "procargs_parse",
    "identity_recheck",
    "identity_reprobe",
  ];
  const reasons = [
    "unsupported",
    "unavailable",
    "invalid_size",
    "setuid",
    "identity_changed",
    "malformed",
    "unclassified",
  ];
  const keys = [
    "enumerated",
    "inspected_same_uid",
    "known_foreign_uid",
    "confirmed_gone",
    "matching_profile",
    "unknown_live",
  ];
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    !["complete", "incomplete"].includes(report?.status) ||
    !keys.every((key) => integer(report.counts?.[key])) ||
    !Array.isArray(report.failures) ||
    report.failures.length > 512
  )
    refuse("profile inventory diagnostic is unavailable; resources retained");
  const failures = report.failures.map((failure) => {
    if (
      !stages.includes(failure?.stage) ||
      !reasons.includes(failure.reason) ||
      !(failure.errno === null || (integer(failure.errno) && failure.errno <= 4095)) ||
      !integer(failure.count) ||
      !failure.count
    )
      refuse("profile inventory diagnostic is unavailable; resources retained");
    return {
      stage: failure.stage,
      reason: failure.reason,
      errno: failure.errno,
      count: failure.count,
    };
  });
  if (report.status === "complete" && (failures.length || report.counts.unknown_live))
    refuse("profile inventory diagnostic is inconsistent; resources retained");
  return {
    status: report.status,
    counts: Object.fromEntries(keys.map((key) => [key, report.counts[key]])),
    failures,
  };
}

function paneMetadata(inspect, session, pane) {
  return {
    pane: inspect("herdr", session, "pane", "get", pane).pane,
    info: inspect("herdr", session, "pane", "process-info", "--pane", pane).process_info,
  };
}

export function validateHerdrMetadata(context, metadata, record, shell, repo, foreground = false) {
  const { pane, info } = metadata;
  if (
    !pane ||
    !info ||
    pane.pane_id !== context.pane ||
    info.pane_id !== context.pane ||
    pane.workspace_id !== context.workspace ||
    pane.tab_id !== context.tab ||
    realpathSync.native(pane.cwd) !== repo ||
    (pane.foreground_cwd && realpathSync.native(pane.foreground_cwd) !== repo) ||
    record?.cwd !== repo ||
    shell?.pid !== info.shell_pid ||
    shell.uid !== process.getuid() ||
    !["zsh", "bash", "sh", "fish"].includes(basename(shell.exe || ""))
  )
    refuse("live Herdr caller, pane, or physical repository placement does not match");
  if (
    !pane.foreground_cwd &&
    !info.foreground_processes?.some(
      (p) => p.pid === record.pid && p.cwd && realpathSync.native(p.cwd) === repo,
    )
  )
    refuse("Herdr foreground physical repository metadata is unavailable");
  if (
    foreground &&
    (pane.agent ||
      pane.agent_session ||
      record.ppid !== shell.pid ||
      record.pgid !== info.foreground_process_group_id ||
      record.tpgid !== record.pgid ||
      !info.foreground_processes?.some((p) => p.pid === record.pid))
  )
    refuse(
      "bridge must run in an ordinary owned foreground Herdr proof shell, outside a coding agent pane",
    );
}

function callerContext(inspect, repo, foreground) {
  if (process.env.HERDR_ENV !== "1")
    refuse("attached bridge commands require live Herdr caller context");
  const context = {
    session: process.env.HERDR_SESSION,
    workspace: process.env.HERDR_WORKSPACE_ID,
    tab: process.env.HERDR_TAB_ID,
    pane: process.env.HERDR_PANE_ID,
  };
  if (
    !/^[A-Za-z0-9_.-]{1,64}$/.test(context.session || "") ||
    !/^w[A-Za-z0-9]+$/.test(context.workspace || "") ||
    !context.tab?.startsWith(`${context.workspace}:t`) ||
    !context.pane?.startsWith(`${context.workspace}:p`)
  )
    refuse("exact Herdr caller IDs and named session are required");
  const current = inspect("herdr", context.session, "pane", "current", "--current").pane;
  const metadata = paneMetadata(inspect, context.session, context.pane);
  if (current?.pane_id !== context.pane)
    refuse("Herdr current caller does not resolve to the explicit pane");
  const record = inspect("record", process.pid);
  const shell = inspect("record", metadata.info?.shell_pid);
  validateHerdrMetadata(context, metadata, record, shell, repo, foreground);
  let ancestor = record;
  const ancestors = [];
  for (let i = 0; i < 24 && ancestor && ancestor.pid !== shell.pid; i++) {
    ancestors.push(ancestor.pid);
    ancestor = inspect("record", ancestor.ppid);
    if (ancestor && ancestor.uid !== process.getuid()) refuse("Herdr caller ancestry is foreign");
  }
  if (
    ancestor?.pid !== shell.pid ||
    !metadata.info.foreground_processes?.some((p) => ancestors.includes(p.pid))
  )
    refuse("Herdr caller is not descended from this pane's live foreground process");
  return {
    ...context,
    guard: { pid: record.pid, start: record.start },
    shell: { pid: shell.pid, start: shell.start },
  };
}

const AXI = "CHROME_DEVTOOLS_AXI_";
const POLICY = "DOTFILES_BROWSER_POLICY_";

function attachedEnvironment(env, url, token) {
  const output = scopedEnvironment(env);
  for (const name of ["SESSION", "PORT", "MCP_PATH"])
    output[`${AXI}${name}`] = env[`${AXI}${name}`];
  for (const name of ["SESSION", "REPO_SHA256", "VERSION"])
    output[`${POLICY}${name}`] = env[`${POLICY}${name}`];
  output[`${AXI}BROWSER_URL`] = url;
  output[`${POLICY}ALLOCATION`] = token;
  output[`${POLICY}MODE`] = "foreground-attach";
  const preload = join(dirname(fileURLToPath(import.meta.url)), "browser-attach-preload.mjs");
  const stat = lstatSync(preload);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o022)
    refuse("attached transport preload is unsafe");
  output.NODE_OPTIONS = `--import=${pathToFileURL(realpathSync.native(preload)).href}`;
  return output;
}

function exactNode(record, script, args = []) {
  if (
    !record ||
    record.uid !== process.getuid() ||
    record.exe !== process.execPath ||
    ![process.execPath, "node"].includes(record.argv?.[0])
  )
    return false;
  try {
    return (
      realpathSync.native(record.argv[1]) === realpathSync.native(script) &&
      JSON.stringify(record.argv.slice(2)) === JSON.stringify(args)
    );
  } catch {
    return false;
  }
}

function checkBridgeEnvironment(record, env) {
  if (!record?.env || !Array.isArray(record.controlNames))
    refuse("foreground bridge environment could not be verified");
  const expected = Object.keys(env).filter(
    (name) =>
      name.startsWith(AXI) ||
      name.startsWith(POLICY) ||
      name === "NODE_OPTIONS" ||
      [
        "HERDR_ENV",
        "HERDR_SESSION",
        "HERDR_WORKSPACE_ID",
        "HERDR_TAB_ID",
        "HERDR_PANE_ID",
      ].includes(name),
  );
  for (const name of expected)
    if (record.env[name] !== env[name])
      refuse("foreground bridge policy or Herdr binding does not match");
  if (record.controlNames.some((name) => !expected.includes(name)))
    refuse("foreground bridge contains unsupported runtime controls");
}

async function verifyBridge(
  inspect,
  allocation,
  request,
  identity,
  bridgePath,
  mcpPath,
  env,
  repo,
  caller,
  api,
  requireReadiness = true,
) {
  const binding = allocation.value.binding;
  if (!binding?.owner || !binding.bridge)
    refuse("start the explicit foreground bridge in the owned Herdr proof pane first");
  if (caller.session !== binding.owner.session || caller.workspace !== binding.owner.workspace)
    refuse("caller is outside the foreground bridge's owned Herdr workspace");
  const guard = inspect("record", binding.owner.guard.pid);
  const expected = [
    "--repo-qa",
    request.task,
    "attach",
    request.receipt,
    "--pid",
    String(request.pid),
    "--port",
    String(request.cdpPort),
    "bridge",
  ];
  const policyPath = join(dirname(fileURLToPath(import.meta.url)), "browser-policy.mjs");
  if (!exactNode(guard, policyPath, expected) || guard.start !== binding.owner.guard.start)
    refuse("foreground bridge supervisor is stale or foreign");
  const metadata = paneMetadata(inspect, binding.owner.session, binding.owner.pane);
  const shell = inspect("record", binding.owner.shell.pid);
  if (shell?.start !== binding.owner.shell.start) refuse("foreground proof shell has changed");
  validateHerdrMetadata(binding.owner, metadata, guard, shell, repo, true);
  if (!api.stateExists(env.HOME, identity.stateDir))
    refuse("foreground bridge session state is missing");
  const pidInfo = api.checkedPidInfo(identity.stateDir, identity.port);
  const bridge = inspect("record", pidInfo.pid);
  if (
    !exactNode(bridge, bridgePath) ||
    bridge.pid !== binding.bridge.pid ||
    bridge.start !== binding.bridge.start ||
    bridge.ppid !== guard.pid ||
    bridge.pgid !== guard.pgid
  )
    refuse("attached bridge is stale, detached, or foreign; recovery requires a new allocation");
  const ownerEnv = {
    ...env,
    HERDR_ENV: "1",
    HERDR_SESSION: binding.owner.session,
    HERDR_WORKSPACE_ID: binding.owner.workspace,
    HERDR_TAB_ID: binding.owner.tab,
    HERDR_PANE_ID: binding.owner.pane,
  };
  checkBridgeEnvironment(bridge, ownerEnv);
  const children = inspect("children", bridge.pid).map((pid) => inspect("record", pid));
  if (
    children.length !== 1 ||
    !exactNode(children[0], mcpPath, [`--browserUrl=http://127.0.0.1:${request.cdpPort}`]) ||
    children[0].ppid !== bridge.pid ||
    children[0].pgid !== guard.pgid
  )
    refuse("foreground bridge is not using only the pinned external Chrome MCP child");
  checkBridgeEnvironment(children[0], ownerEnv);
  validateListener(inspect("listeners", identity.port), bridge.pid, identity.port);
  if (requireReadiness) {
    const health = await readJson(`http://127.0.0.1:${identity.port}/health?deep=1`);
    if (health.status !== "ok" || health.session !== identity.session || health.pageIdentityChanged)
      refuse("foreground bridge is unhealthy or reconnected; prepare a fresh proof");
  }
  if (inspect("record", bridge.pid)?.start !== bridge.start)
    refuse("foreground bridge changed during its health probe");
  validateListener(inspect("listeners", identity.port), bridge.pid, identity.port);
  return bridge;
}

function updateAllocation(allocation) {
  saveReceipt(allocation.receipt, allocation.value, allocation.key);
}

async function foregroundBridge(
  inspect,
  allocation,
  request,
  identity,
  bridgePath,
  mcpPath,
  env,
  repo,
  owner,
  api,
) {
  if (allocation.value.binding)
    refuse("this allocation already began its one foreground proof; prepare a fresh profile");
  if (api.stateExists(env.HOME, identity.stateDir) || !(await api.isPortAvailable(identity.port)))
    refuse("this task bridge state or port already exists; prepare a fresh task name");
  const binding = await verifyChrome(inspect, allocation, request);
  const sessions = dirname(identity.stateDir);
  try {
    mkdirSync(sessions, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  mkdirSync(identity.stateDir, { mode: 0o700 });
  if (!api.stateExists(env.HOME, identity.stateDir))
    refuse("foreground bridge state could not be allocated");
  allocation.value.binding = { ...binding, owner, bridge: null };
  updateAllocation(allocation);
  const child = spawn(process.execPath, [bridgePath], {
    env,
    cwd: repo,
    detached: false,
    stdio: "ignore",
  });
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once("error", () => {
      exited = true;
      resolve(78);
    });
    child.once("exit", (code) => {
      exited = true;
      resolve(code ?? 78);
    });
  });
  const stop = () => {
    if (!exited) child.kill("SIGTERM");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  let monitor;
  let failed = false;
  try {
    const record = inspect("record", child.pid);
    if (!exactNode(record, bridgePath) || record.ppid !== process.pid)
      refuse("foreground bridge child ownership could not be verified");
    allocation.value.binding.bridge = { pid: record.pid, start: record.start };
    updateAllocation(allocation);
    const deadline = Date.now() + 10000;
    while (!exited && Date.now() < deadline) {
      if (api.stateExists(env.HOME, identity.stateDir)) {
        try {
          await verifyBridge(
            inspect,
            allocation,
            request,
            identity,
            bridgePath,
            mcpPath,
            env,
            repo,
            owner,
            api,
          );
          break;
        } catch {
          /* Startup is bounded, with no retry launch. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await verifyBridge(
      inspect,
      allocation,
      request,
      identity,
      bridgePath,
      mcpPath,
      env,
      repo,
      owner,
      api,
    );
    process.stdout.write(
      "Verified foreground attached bridge ready; keep this proof shell running.\n",
    );
    let checking = false;
    monitor = setInterval(async () => {
      if (checking || exited) return;
      checking = true;
      try {
        readAllocation(env.HOME, repo, request.task, request.receipt);
        await verifyChrome(inspect, allocation, request);
        await verifyBridge(
          inspect,
          allocation,
          request,
          identity,
          bridgePath,
          mcpPath,
          env,
          repo,
          owner,
          api,
        );
      } catch (error) {
        failed = true;
        process.stderr.write(
          `Attached proof ownership expired or changed; foreground bridge stopping: ${error instanceof AttachmentError ? error.message : "inspection failed"}\n`,
        );
        stop();
      } finally {
        checking = false;
      }
    }, 1000);
    const code = await exit;
    return failed ? 78 : code;
  } finally {
    clearInterval(monitor);
    stop();
    await exit;
    allocation.value.closed = true;
    updateAllocation(allocation);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function stopOwnedBridge(inspect, bridge) {
  const current = inspect("record", bridge.pid);
  if (current?.start !== bridge.start) refuse("bridge identity changed before stop");
  process.kill(bridge.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const live = inspect("record", bridge.pid);
    if (!live || live.start !== bridge.start) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  refuse("foreground bridge did not exit; profile and evidence retained");
}

export function cleanup(inspect, allocation, request) {
  const { value } = allocation;
  if (
    value.binding &&
    (value.binding.pid !== request.pid || value.binding.port !== request.cdpPort)
  )
    refuse("cleanup does not match the allocated proof");
  // Do not infer absence from an incomplete inventory. The inspector throws
  // unless every unknown PID is freshly kernel-confirmed gone or a zombie.
  // Re-probe exact process survivors and profile users just before removal.
  for (let probe = 0; probe < 2; probe++) {
    if (
      inspect("record", request.pid) ||
      (value.binding?.bridge && inspect("record", value.binding.bridge.pid)) ||
      inspect("listeners", request.cdpPort).length ||
      inspect("profile-users", value.profile).length
    )
      refuse(
        "close the exact owned Chrome and foreground bridge before cleanup; resources retained",
      );
    const profile = privatePath(value.profile, true);
    if (profile.dev !== value.dev || profile.ino !== value.ino)
      refuse("allocated profile identity changed; resources retained");
  }
  rmSync(value.profile, { recursive: true });
  value.closed = true;
  value.cleaned = true;
  updateAllocation(allocation);
  process.stdout.write("Owned disposable profile removed; signed retirement receipt retained.\n");
  return 0;
}

export function attachClientSource(source) {
  const entries = [
    [
      "export async function ensureBridge(spawnBridge = spawnBridgeProcess, notice) {",
      "return await globalThis[Symbol.for('dotfiles.browser.attach.ensure')]();",
    ],
    [
      "export async function stopBridge() {",
      "throw new Error('Attached bridge stop is owned by the repository guard');",
    ],
    [
      "export async function callTool(name, args = {}) {",
      "await globalThis[Symbol.for('dotfiles.browser.attach.tool')](name, args);",
    ],
  ];
  for (const [needle, body] of entries) {
    if (source.split(needle).length !== 2)
      refuse("pinned backend lifecycle seam changed; attached commands are unsupported");
    source = source.replace(needle, `${needle}\n    ${body}`);
  }
  return source;
}

function captureOutput(stream, budget) {
  const write = stream.write;
  const chunks = [];
  stream.write = function (chunk, encoding, callback) {
    if (typeof chunk !== "string" && !ArrayBuffer.isView(chunk))
      refuse("attached Axi output used an unsupported encoding");
    const encodingName = typeof encoding === "string" ? encoding : (encoding?.encoding ?? "utf8");
    const size = ArrayBuffer.isView(chunk)
      ? chunk.byteLength
      : Buffer.byteLength(chunk, encodingName);
    budget.size += size;
    if (budget.size > MAX_BACKEND_OUTPUT_BYTES)
      refuse("attached Axi output exceeded its bounded evidence limit");
    const data = ArrayBuffer.isView(chunk)
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(chunk, encodingName);
    chunks.push(Buffer.from(data));
    const done = typeof encoding === "function" ? encoding : callback;
    if (typeof done === "function") queueMicrotask(done);
    return true;
  };
  return {
    restore() {
      stream.write = write;
    },
    release() {
      stream.write = write;
      for (const chunk of chunks) write.call(stream, chunk);
      chunks.length = 0;
    },
    discard() {
      stream.write = write;
      chunks.length = 0;
    },
  };
}

async function runAttachedBackend(request, env, verify, origins, api, home) {
  const { registerHooks } = nodeModule;
  if (typeof registerHooks !== "function")
    refuse("this Node runtime cannot guard the pinned backend lifecycle");
  const cli = api.checkedPackage(home, "chrome-devtools-axi", AXI_VERSION, "dist/src/cli.js");
  const client = api.checkedPackage(home, "chrome-devtools-axi", AXI_VERSION, "dist/src/client.js");
  attachClientSource(readFileSync(client, "utf8"));
  for (const name of Object.keys(process.env))
    if (name.startsWith(AXI) || name.startsWith(POLICY) || name === "PLAYWRIGHT_BROWSERS_PATH")
      delete process.env[name];
  Object.assign(process.env, env);
  globalThis[Symbol.for("dotfiles.browser.attach.ensure")] = verify;
  globalThis[Symbol.for("dotfiles.browser.attach.tool")] = async (name, args) => {
    await verify();
    if (
      (name === "new_page" || (name === "navigate_page" && args.type === "url")) &&
      !allowedTarget(args.url, origins)
    )
      refuse("navigation is outside this allocation's exact synthetic loopback target");
  };
  const url = pathToFileURL(client).href;
  const hook = registerHooks({
    load(moduleUrl, context, nextLoad) {
      const result = nextLoad(moduleUrl, context);
      return moduleUrl === url
        ? { ...result, source: attachClientSource(String(result.source)) }
        : result;
    },
  });
  const budget = { size: 0 };
  const stdout = captureOutput(process.stdout, budget);
  const stderr = captureOutput(process.stderr, budget);
  const previousExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    let backendError;
    try {
      const module = await import(pathToFileURL(cli).href);
      await module.main({ argv: [request.command, ...request.commandArgs] });
    } catch (error) {
      backendError = error;
    }
    const backendExitCode = process.exitCode;
    await verify();
    if (backendError instanceof AttachmentError) throw backendError;
    if (backendError || backendExitCode)
      refuse("attached Axi command failed; backend output was withheld");
    stdout.release();
    stderr.release();
    return 0;
  } catch (error) {
    stdout.discard();
    stderr.discard();
    if (error instanceof AttachmentError) throw error;
    refuse("attached Axi command failed; backend output was withheld");
  } finally {
    stdout.restore();
    stderr.restore();
    hook.deregister();
    process.exitCode = previousExitCode;
    delete globalThis[Symbol.for("dotfiles.browser.attach.ensure")];
    delete globalThis[Symbol.for("dotfiles.browser.attach.tool")];
  }
}

async function runAttachmentLocked(home, repo, request, api) {
  const allocation = readAllocation(
    home,
    repo,
    request.task,
    request.receipt,
    ["cleanup", "stop", "diagnose"].includes(request.command),
  );
  if (realpathSync.native(process.cwd()) !== repo)
    refuse("attachment requires the physical Git root as current directory");
  const inspect = inspector();
  if (request.command === "cleanup") {
    // Expired allocations identify retained resources, not stale caller authority.
    const caller = callerContext(inspect, repo, false);
    assertCallerWorkspace(allocation, caller);
    return cleanup(inspect, allocation, request);
  }
  if (
    ["open", "newpage"].includes(request.command) &&
    !allowedTarget(
      requestedNavigationTarget(request.command, request.commandArgs),
      allocation.value.origins,
    )
  )
    refuse("navigation is outside this allocation's exact synthetic loopback target");
  if (request.command === "diagnose") {
    const caller = callerContext(inspect, repo, false);
    assertCallerWorkspace(allocation, caller);
    return diagnose(home, inspect, allocation, request, caller);
  }
  if (typeof nodeModule.registerHooks !== "function")
    refuse("this Node runtime cannot guard the pinned backend lifecycle");
  const owner = callerContext(inspect, repo, request.command === "bridge");
  assertCallerWorkspace(allocation, owner);
  const identity = api.makeIdentity(home, repo, request.task);
  if (request.command === "stop" && !allocation.value.binding) {
    const { before } = chromeOwnership(inspect, allocation, request);
    const unbound = () => {
      try {
        lstatSync(join(dirname(request.receipt), "lock"));
        refuse("allocation is busy or retains a failed proof lock; resources retained");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (api.stateExists(home, identity.stateDir) || inspect("listeners", identity.port).length)
        refuse("unbound task has bridge state or a listener; resources retained");
      const current = readAllocation(home, repo, request.task, request.receipt, true);
      if (current.value.binding) refuse("allocation acquired a proof binding; resources retained");
    };
    unbound();
    recheckChromeOwnership(inspect, allocation, request, before);
    unbound();
    process.stdout.write(
      "No owned foreground bridge was created; externally owned Chrome and profile retained.\n",
    );
    return 0;
  }
  const backend = api.checkedPackage(
    home,
    "chrome-devtools-axi",
    AXI_VERSION,
    "dist/bin/chrome-devtools-axi.js",
  );
  const mcp = api.checkedPackage(
    home,
    "chrome-devtools-mcp",
    MCP_VERSION,
    "build/src/bin/chrome-devtools-mcp.js",
  );
  const bridgePath = api.checkedLocalScript(join(dirname(backend), BRIDGE_NAME), process.getuid());
  const env = attachedEnvironment(
    api.buildBackendEnvironment(home, identity, identity.repoHash, mcp),
    `http://127.0.0.1:${request.cdpPort}`,
    allocation.value.token,
  );
  if (request.command === "bridge")
    return foregroundBridge(
      inspect,
      allocation,
      request,
      identity,
      bridgePath,
      mcp,
      env,
      repo,
      owner,
      api,
    );
  let verifiedBridge;
  const verify = async () => {
    readAllocation(home, repo, request.task, request.receipt, request.command === "stop");
    const stopping = request.command === "stop";
    const chrome = stopping ? chromeOwnership(inspect, allocation, request) : undefined;
    if (!stopping) await verifyChrome(inspect, allocation, request);
    verifiedBridge = await verifyBridge(
      inspect,
      allocation,
      request,
      identity,
      bridgePath,
      mcp,
      env,
      repo,
      owner,
      api,
      !stopping,
    );
    if (stopping) recheckChromeOwnership(inspect, allocation, request, chrome.before);
    return identity.port;
  };
  await verify();
  if (request.command === "stop") {
    await stopOwnedBridge(inspect, verifiedBridge);
    if (inspect("listeners", identity.port).length)
      refuse("bridge listener survived stop; resources retained");
    process.stdout.write(
      "Owned foreground bridge stopped; externally owned Chrome and profile retained.\n",
    );
    return 0;
  }
  return runAttachedBackend(request, env, verify, allocation.value.origins, api, home);
}

export async function runAttachment(home, repo, request, api) {
  requireAttachmentLifecycle(request.command);
  readAllocation(
    home,
    repo,
    request.task,
    request.receipt,
    ["cleanup", "stop", "diagnose"].includes(request.command),
  );
  if (!["bridge", "cleanup"].includes(request.command))
    return runAttachmentLocked(home, repo, request, api);
  const lock = join(dirname(request.receipt), "lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch {
    refuse("allocation is busy or retains a failed proof lock; no resource was changed");
  }
  const identity = privatePath(lock, true);
  try {
    return await runAttachmentLocked(home, repo, request, api);
  } finally {
    const current = privatePath(lock, true);
    if (current.dev !== identity.dev || current.ino !== identity.ino)
      refuse("allocation lock changed; resources retained");
    rmdirSync(lock);
  }
}
