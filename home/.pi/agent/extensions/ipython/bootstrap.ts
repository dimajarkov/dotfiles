import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const BOOTSTRAP_SCHEMA = 3;
const PYTHON_VERSION = "3.11.13";
const VERSION_FILE = ".pi-ipython-bootstrap.json";
const LOCK_SUFFIX = ".bootstrap.lock";
const LOCK_RETRY_MS = 100;
const LOCK_STALE_MS = 30_000;
const REQUIREMENTS_LOCK = join(dirname(fileURLToPath(import.meta.url)), "requirements.lock");
const REQUIREMENTS_LOCK_SHA256 = createHash("sha256").update(readFileSync(REQUIREMENTS_LOCK)).digest("hex");

const REQUIRED_IMPORTS = [
  "ipykernel",
  "dill",
  "requests",
  "httpx",
  "yaml",
  "tomli",
  "dotenv",
  "pandas",
  "numpy",
  "scipy",
  "bs4",
  "lxml",
  "pydantic",
  "tyro",
] as const;

export const DEFAULT_PYTHON_PACKAGE_LABELS = [
  "requests",
  "httpx",
  "yaml (PyYAML)",
  "tomli",
  "dotenv (python-dotenv)",
  "pandas",
  "numpy",
  "scipy",
  "bs4 (Beautiful Soup)",
  "lxml",
  "pydantic",
  "tyro",
] as const;

export interface KernelPythonSkill {
  name: string;
  importName: string;
  packagePath: string;
  pyprojectPath: string;
}

export type KernelBootstrapProgressHandler = (message: string) => void;

export interface EnsureKernelPythonOptions {
  pythonSkills?: readonly KernelPythonSkill[];
  onProgress?: KernelBootstrapProgressHandler;
  signal?: AbortSignal;
}

type BootstrapSkill = KernelPythonSkill & { pyprojectSha256: string };
type BootstrapVersion = {
  schema: number;
  python: string;
  requirementsLockSha256: string;
  pythonSkills: BootstrapSkill[];
};

let inFlight: { key: string; promise: Promise<string> } | undefined;

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function pythonPath(venv: string): string {
  return process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
}

function report(options: EnsureKernelPythonOptions, message: string): void {
  options.onProgress?.(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const names = process.platform === "win32" ? [`${name}.exe`, name] : [name];
    for (const candidate of names) {
      const path = join(directory, candidate);
      if (await isExecutable(path)) return path;
    }
  }
  return undefined;
}

async function run(command: string, args: readonly string[], signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("IPython setup aborted");
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let settled = false;
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolveRun();
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("IPython setup aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });
    child.on("error", (error) => finish(error));
    child.on("exit", (code, childSignal) => {
      if (code === 0) {
        finish();
        return;
      }
      const reason = childSignal ? `signal ${childSignal}` : `exit code ${code}`;
      finish(new Error(`${command} ${args.join(" ")} failed with ${reason}${stderr ? `\n${stderr.trim()}` : ""}`));
    });
  });
}

async function importsWork(
  python: string,
  skills: readonly BootstrapSkill[] = [],
  signal?: AbortSignal,
): Promise<boolean> {
  const imports = [...REQUIRED_IMPORTS, ...skills.map((skill) => skill.importName)];
  try {
    await run(python, ["-c", imports.map((name) => `import ${name}`).join("; ")], signal);
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

function fileSha256(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "missing";
  }
}

function normalizePythonSkills(skills: readonly KernelPythonSkill[] | undefined): BootstrapSkill[] {
  const unique = new Map<string, BootstrapSkill>();
  for (const skill of skills ?? []) {
    const normalized: BootstrapSkill = {
      name: skill.name,
      importName: skill.importName,
      packagePath: resolve(skill.packagePath),
      pyprojectPath: resolve(skill.pyprojectPath),
      pyprojectSha256: fileSha256(skill.pyprojectPath),
    };
    unique.set(`${normalized.importName}\0${normalized.packagePath}`, normalized);
  }
  return [...unique.values()];
}

function skillsMatch(actual: BootstrapSkill[] | undefined, expected: readonly BootstrapSkill[]): boolean {
  if (!actual || actual.length !== expected.length) return false;
  return actual.every((skill, index) => {
    const candidate = expected[index];
    return Boolean(
      candidate &&
        skill.name === candidate.name &&
        skill.importName === candidate.importName &&
        skill.packagePath === candidate.packagePath &&
        skill.pyprojectPath === candidate.pyprojectPath &&
        skill.pyprojectSha256 === candidate.pyprojectSha256,
    );
  });
}

async function versionIsCurrent(venv: string, skills: readonly BootstrapSkill[]): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(join(venv, VERSION_FILE), "utf8")) as BootstrapVersion;
    return (
      parsed.schema === BOOTSTRAP_SCHEMA &&
      parsed.python === PYTHON_VERSION &&
      parsed.requirementsLockSha256 === REQUIREMENTS_LOCK_SHA256 &&
      skillsMatch(parsed.pythonSkills, skills)
    );
  } catch {
    return false;
  }
}

async function ready(venv: string, skills: readonly BootstrapSkill[], signal?: AbortSignal): Promise<boolean> {
  const python = pythonPath(venv);
  return (
    (await isExecutable(python)) &&
    (await versionIsCurrent(venv, skills)) &&
    (await importsWork(python, skills, signal))
  );
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function lockIsStale(lockDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(lockDir, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) return !processIsRunning(pid);
  } catch {
    // Fall through to an age check when the owner did not finish writing its pid.
  }
  try {
    return Date.now() - (await stat(lockDir)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

async function acquireLock(venv: string, signal?: AbortSignal): Promise<() => Promise<void>> {
  const lockDir = `${venv}${LOCK_SUFFIX}`;
  await mkdir(dirname(lockDir), { recursive: true });
  for (;;) {
    if (signal?.aborted) throw new Error("IPython setup aborted");
    try {
      await mkdir(lockDir);
      await writeFile(join(lockDir, "pid"), `${process.pid}\n`, "utf8");
      return () => rm(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      if (await lockIsStale(lockDir)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      try {
        await sleep(LOCK_RETRY_MS, undefined, { signal });
      } catch (error) {
        if (signal?.aborted) throw new Error("IPython setup aborted");
        throw error;
      }
    }
  }
}

function venvPath(): string {
  const override = process.env.PI_IPYTHON_VENV;
  return override ? resolve(expandHome(override)) : join(homedir(), ".pi", "agent", "ipython-venv");
}

async function verifyOverride(
  path: string,
  skills: readonly BootstrapSkill[],
  signal?: AbortSignal,
): Promise<string> {
  if (!(await isExecutable(path))) {
    throw new Error(`PI_IPYTHON_PYTHON is not executable: ${path}`);
  }
  if (!(await importsWork(path, skills, signal))) {
    throw new Error(`PI_IPYTHON_PYTHON must provide: ${[...REQUIRED_IMPORTS, ...skills.map((skill) => skill.importName)].join(", ")}`);
  }
  return path;
}

async function installPythonSkills(
  uv: string,
  python: string,
  skills: readonly BootstrapSkill[],
  signal?: AbortSignal,
): Promise<void> {
  if (skills.length === 0) return;
  await run(
    uv,
    ["pip", "install", "--python", python, ...skills.flatMap((skill) => ["--editable", skill.packagePath])],
    signal,
  );
}

async function ensureUncached(options: EnsureKernelPythonOptions, skills: readonly BootstrapSkill[]): Promise<string> {
  const override = process.env.PI_IPYTHON_PYTHON;
  if (override) return verifyOverride(resolve(expandHome(override)), skills, options.signal);

  const venv = venvPath();
  if (await ready(venv, skills, options.signal)) return pythonPath(venv);

  const release = await acquireLock(venv, options.signal);
  try {
    if (await ready(venv, skills, options.signal)) return pythonPath(venv);

    const uv = await findExecutable("uv");
    if (!uv) {
      throw new Error("uv is required for one-time IPython setup. Install it from https://docs.astral.sh/uv/");
    }

    report(options, skills.length > 0 ? "Setting up IPython kernel and Python skills (one time)..." : "Setting up IPython kernel (one time)...");
    if (existsSync(venv)) await rm(venv, { recursive: true, force: true });
    await mkdir(dirname(venv), { recursive: true });
    await run(uv, ["python", "install", PYTHON_VERSION], options.signal);
    await run(uv, ["venv", venv, "--python", PYTHON_VERSION, "--seed"], options.signal);
    const python = pythonPath(venv);
    await run(uv, [
      "pip",
      "install",
      "--python",
      python,
      "--require-hashes",
      "--requirements",
      REQUIREMENTS_LOCK,
    ], options.signal);
    await installPythonSkills(uv, python, skills, options.signal);
    const version: BootstrapVersion = {
      schema: BOOTSTRAP_SCHEMA,
      python: PYTHON_VERSION,
      requirementsLockSha256: REQUIREMENTS_LOCK_SHA256,
      pythonSkills: [...skills],
    };
    await writeFile(join(venv, VERSION_FILE), `${JSON.stringify(version)}\n`, "utf8");
    if (!(await importsWork(python, skills, options.signal))) {
      throw new Error("The new kernel environment failed its import verification");
    }
    report(options, skills.length > 0 ? "IPython kernel and Python skills ready" : "IPython kernel ready");
    return python;
  } catch (error) {
    throw new Error(`Failed to set up the IPython kernel. ${errorMessage(error)}`);
  } finally {
    await release().catch(() => undefined);
  }
}

export function ensureKernelPython(options: EnsureKernelPythonOptions = {}): Promise<string> {
  const skills = normalizePythonSkills(options.pythonSkills);
  const key = JSON.stringify(skills);
  if (inFlight?.key === key) return inFlight.promise;
  const promise = ensureUncached(options, skills).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { key, promise };
  return promise;
}
