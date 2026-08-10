import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelBootstrapProgressHandler, KernelPythonSkill } from "./bootstrap.js";
import { type ExecuteResult, KernelManager } from "./kernel.js";
import {
  manifestPathIn,
  type RestoreResult,
  snapshotPathIn,
} from "./state-snapshot.js";

const KERNEL_BOOTSTRAP_BASE = `
import asyncio
import os as _pi_ipython_os
import sys as _pi_ipython_sys

_pi_ipython_os.environ["NO_COLOR"] = "1"
_pi_ipython_os.environ["PATH"] = _pi_ipython_os.path.dirname(_pi_ipython_sys.executable) + _pi_ipython_os.pathsep + _pi_ipython_os.environ.get("PATH", "")
try:
    get_ipython().colors = "NoColor"
except Exception:
    pass

try:
    import nest_asyncio as _pi_ipython_nest_asyncio
    _pi_ipython_nest_asyncio.apply()
except Exception:
    pass
`.trim();

function buildKernelBootstrap(pythonSkills: readonly KernelPythonSkill[]): string {
  const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
  if (importNames.length === 0) return KERNEL_BOOTSTRAP_BASE;
  return `${KERNEL_BOOTSTRAP_BASE}

import importlib as _pi_ipython_importlib
import inspect as _pi_ipython_inspect
import sys as _pi_ipython_sys
import types as _pi_ipython_types

class _PiCallableSkillModule(_pi_ipython_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _pi_ipython_inspect.isawaitable(result):
            return await result
        return result

class _PiUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self.__doc__ = f"Python skill {name} is unavailable: {error}"
        self._pi_import_error = error

    async def run(self, *args, **kwargs):
        raise RuntimeError(f"Python skill {self.__name__} is unavailable: {self._pi_import_error}")

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._pi_import_error}>"

def _pi_wrap_skill(module):
    run = getattr(module, "run", None)
    if not callable(run) or isinstance(module, _PiCallableSkillModule):
        return module
    wrapped = _PiCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _pi_ipython_inspect.signature(run)
    except Exception:
        pass
    if getattr(run, "__doc__", None):
        wrapped.__doc__ = run.__doc__
    _pi_ipython_sys.modules[module.__name__] = wrapped
    return wrapped

_PI_PYTHON_SKILL_IMPORT_ERRORS = {}
for _pi_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_pi_skill_name] = _pi_wrap_skill(_pi_ipython_importlib.import_module(_pi_skill_name))
    except Exception as _pi_skill_error:
        _PI_PYTHON_SKILL_IMPORT_ERRORS[_pi_skill_name] = str(_pi_skill_error)
        globals()[_pi_skill_name] = _PiUnavailableSkill(_pi_skill_name, str(_pi_skill_error))
`.trim();
}

function createAbortError(): Error {
  return new Error("IPython execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export interface IpythonRuntimeOptions {
  cwd: string;
  sessionId: string;
  python?: string;
  env?: Record<string, string>;
  snapshotDir?: string;
  pythonSkills?: readonly KernelPythonSkill[];
}

export class IpythonRuntime {
  private managerPromise?: Promise<KernelManager>;
  private startupController?: AbortController;
  private manager?: KernelManager;
  private restore?: RestoreResult;
  private restoreConsumed = false;
  private disposed = false;
  private startupMessage?: string;
  private readonly listeners = new Set<KernelBootstrapProgressHandler>();

  constructor(private readonly options: IpythonRuntimeOptions) {}

  get isRunning(): boolean {
    return this.manager?.isRunning ?? false;
  }

  get currentStartupMessage(): string | undefined {
    return this.startupMessage;
  }

  prewarm(): void {
    void this.ensure().catch(() => undefined);
  }

  consumeRestore(): RestoreResult | undefined {
    if (this.restoreConsumed) return undefined;
    this.restoreConsumed = true;
    return this.restore;
  }

  async ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
    if (this.disposed) throw new Error("IPython runtime has been disposed");
    if (signal?.aborted) throw createAbortError();

    if (onProgress && !this.manager) {
      this.listeners.add(onProgress);
      if (this.startupMessage) onProgress(this.startupMessage);
    }
    if (!this.managerPromise) {
      const controller = new AbortController();
      this.startupController = controller;
      const startup = this.start(controller.signal);
      this.managerPromise = startup;
      startup.then(
        (manager) => {
          if (this.managerPromise === startup) {
            this.manager = manager;
            this.startupController = undefined;
          }
          this.settleStartup();
        },
        () => {
          if (this.managerPromise === startup) {
            this.managerPromise = undefined;
            this.startupController = undefined;
          }
          this.settleStartup();
        },
      );
    }

    try {
      return await raceWithAbort(this.managerPromise, signal);
    } finally {
      if (onProgress) this.listeners.delete(onProgress);
    }
  }

  async execute(
    code: string,
    options: {
      signal?: AbortSignal;
      onStream?: (chunk: string, name: "stdout" | "stderr") => void;
      onRichOutput?: (text: string, kind: "display" | "result" | "error") => void;
    } = {},
  ): Promise<ExecuteResult> {
    const started = Date.now();
    try {
      const manager = await this.ensure(undefined, options.signal);
      return await manager.execute(code, options);
    } catch (error) {
      if (options.signal?.aborted) {
        return { stdout: "", stderr: "", status: "aborted", durationMs: Date.now() - started };
      }
      throw error;
    }
  }

  async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
    const manager = await this.ensure(undefined, signal);
    return manager.listNamespaceNames(signal);
  }

  async setModelSupportsImages(supported: boolean, signal?: AbortSignal): Promise<void> {
    const manager = await this.ensure(undefined, signal);
    const value = JSON.stringify(supported ? "1" : "0");
    const result = await manager.execute(
      `import os as _pi_image_os\n_pi_image_os.environ["PI_MODEL_SUPPORTS_IMAGES"] = ${value}`,
      { signal, internal: true },
    );
    if (result.status !== "ok") {
      throw new Error(result.error?.evalue || "Failed to update IPython image capability");
    }
  }

  async reset(): Promise<void> {
    const pending = this.managerPromise;
    this.startupController?.abort();
    this.startupController = undefined;
    this.managerPromise = undefined;
    this.manager = undefined;
    this.restore = undefined;
    this.restoreConsumed = true;
    if (pending) {
      try {
        await (await pending).kill();
      } catch {
        // A failed startup already cleaned itself up.
      }
    }
    if (this.options.snapshotDir) {
      await Promise.all([
        rm(snapshotPathIn(this.options.snapshotDir), { force: true }),
        rm(manifestPathIn(this.options.snapshotDir), { force: true }),
      ]).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.managerPromise;
    this.startupController?.abort();
    this.startupController = undefined;
    this.managerPromise = undefined;
    this.manager = undefined;
    if (!pending) return;
    try {
      await (await pending).dispose();
    } catch {
      // A failed startup already cleaned itself up.
    }
  }

  private emit(message: string): void {
    this.startupMessage = message;
    for (const listener of this.listeners) listener(message);
  }

  private settleStartup(): void {
    this.startupMessage = undefined;
    this.listeners.clear();
  }

  private async start(signal?: AbortSignal): Promise<KernelManager> {
    this.emit("Starting IPython kernel...");
    const snapshot = this.options.snapshotDir
      ? {
          path: snapshotPathIn(this.options.snapshotDir),
          manifestPath: manifestPathIn(this.options.snapshotDir),
        }
      : undefined;
    const manager = new KernelManager({
      cwd: this.options.cwd,
      env: this.options.env,
      python: this.options.python,
      sessionId: this.options.sessionId,
      snapshot,
      username: "pi",
      pythonSkills: this.options.pythonSkills,
    });

    try {
      await manager.start({
        signal,
        onBootstrapProgress: (message) => this.emit(message),
      });
      if (snapshot) {
        const existed = existsSync(snapshot.path);
        this.emit("Restoring IPython state...");
        const restored = await raceWithAbort(manager.restoreState(), signal);
        if (existed) {
          this.restore = restored ?? { restored: [], failed: [], path: snapshot.path };
        }
      }
      this.emit("Preparing IPython runtime...");
      const bootstrap = await raceWithAbort(
        manager.execute(buildKernelBootstrap(this.options.pythonSkills ?? []), { signal, internal: true }),
        signal,
      );
      if (bootstrap.status !== "ok") {
        const output = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
        throw new Error(`Failed to initialize the IPython runtime${output ? `:\n${output}` : ""}`);
      }
      return manager;
    } catch (error) {
      await manager.dispose().catch(() => undefined);
      throw error;
    }
  }
}
