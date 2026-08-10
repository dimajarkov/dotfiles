import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  formatSkillsForPrompt,
  truncateHead,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_PYTHON_PACKAGE_LABELS } from "./bootstrap.js";
import { KernelBusyAfterInterruptError, type ExecuteResult } from "./kernel.js";
import {
  type IpythonToolDetails,
  IpythonRendererTracker,
  renderIpythonCall,
  renderIpythonResult,
} from "./renderer.js";
import { discoverPythonSkills, type DiscoveredPythonSkill } from "./python-skills.js";
import { IpythonRuntime } from "./runtime.js";

const LOCAL_BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
const WAIT_CHOICE = "Wait and preserve state";
const RESTART_CHOICE = "Restart kernel and lose in-memory state";
const MAX_NAMES_IN_RESTORE_NOTICE = 100;
const INCLUDE_PROJECT_PYTHON_SKILLS = process.env.PI_IPYTHON_PROJECT_SKILLS === "1";

const IPYTHON_GUIDANCE = [
  "Use ipython as the primary local control environment for reasoning, context management, state, tool orchestration, and recursive analysis. Keep intermediate variables, helper functions, parsed outputs, and useful notes in the persistent kernel.",
  "Use ipython Python code for reading, searching, and editing files. Assign read and search results to named variables so they can be sliced, filtered, and revisited without reading the same data again.",
  "Use `%%bash` cells in ipython for shell commands. `%%bash` must be the first line of the cell, with no comments, spaces, blank lines, imports, or Python statements before it.",
  "Do not assume ipython is the native runtime of an external project, package, service, dataset, benchmark, or API. Evaluate external systems through their own normal interface, then use ipython to coordinate and analyze the results.",
  "Do not install dependencies into the ipython kernel just to make a target project import or run there. Run project imports, tests, scripts, CLIs, and dependency checks through the project's documented environment, such as `uv run`, its `.venv`, npm, or another native command.",
  "Each ipython `%%bash` cell uses a throw-away subshell, so `cd`, `export`, `source`, and shell variables do not persist across cells. Keep dependent shell steps in one cell, or use `%cd`, `os.environ`, or `%env` for state that must survive.",
  "Python state in ipython persists across calls and turns, including variables, imports, functions, classes, parsed data, and helper structures. Reuse that state instead of repeating work.",
] as const;

const IpythonParameters = Type.Object({
  code: Type.String({
    description:
      "Python scratchpad code or a `%%bash` shell cell to execute in the persistent agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks.",
  }),
});

function artifactDir(ctx: ExtensionContext): string | undefined {
  if (!ctx.sessionManager.getSessionFile()) return undefined;
  return join(homedir(), ".pi", "agent", "session-artifacts", ctx.sessionManager.getSessionId());
}

function outputPath(toolCallId: string): string {
  const directory = join(homedir(), ".pi", "agent", "tool-output");
  mkdirSync(directory, { recursive: true });
  const safeId = toolCallId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(directory, `ipython-${Date.now()}-${safeId}.log`);
}

function boundField(value: string | undefined): string | undefined {
  if (!value) return value;
  return truncateHead(value, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES }).content;
}

class OutputLineCounter {
  private hasData = false;
  private newlineCount = 0;
  private endsWithNewline = false;

  feed(chunk: string): void {
    if (chunk.length === 0) return;
    this.hasData = true;
    this.newlineCount += chunk.split("\n").length - 1;
    this.endsWithNewline = chunk.endsWith("\n");
  }

  value(): number {
    if (!this.hasData) return 0;
    return this.newlineCount + (this.endsWithNewline ? 0 : 1);
  }
}

function restoreNotice(runtime: IpythonRuntime): {
  text?: string;
  restoredNames?: string[];
  restoreFailures?: Array<{ name: string; reason: string }>;
} {
  const restore = runtime.consumeRestore();
  if (!restore) return {};
  const summarize = (names: string[]) => {
    const shown = names.slice(0, MAX_NAMES_IN_RESTORE_NOTICE);
    const remainder = names.length - shown.length;
    return `${shown.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""}`;
  };
  const restored = restore.restored.length > 0 ? summarize(restore.restored) : "none";
  const failed = restore.failed.length > 0
    ? ` Failed to restore: ${summarize(restore.failed.map((entry) => entry.name))}.`
    : "";
  return {
    text: `<ipython_state_restore>Restored names: ${restored}.${failed}</ipython_state_restore>`,
    restoredNames: restore.restored,
    restoreFailures: restore.failed,
  };
}

function setWorkingMessage(ctx: ExtensionContext, message?: string): void {
  try {
    ctx.ui.setWorkingMessage(message);
  } catch {
    // UI state is cosmetic and may already belong to a replacement session.
  }
}

async function runCell(
  runtime: IpythonRuntime,
  code: string,
  signal: AbortSignal | undefined,
  onStream: (chunk: string, name: "stdout" | "stderr") => void,
  onRichOutput: (text: string, kind: "display" | "result" | "error") => void,
  onProgress: (message: string) => void,
  ctx: ExtensionContext,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {
  let kernelRestarted = false;
  for (;;) {
    try {
      await runtime.ensure(onProgress, signal);
      return {
        result: await runtime.execute(code, { signal, onStream, onRichOutput }),
        kernelRestarted,
      };
    } catch (error) {
      if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) throw error;
      if (!ctx.hasUI) throw error;
      const choice = await ctx.ui.select(
        "Interrupted IPython cell is still running\nWaiting preserves kernel state. Restarting loses variables, imports, tasks, and open resources.",
        [WAIT_CHOICE, RESTART_CHOICE],
        { signal },
      );
      if (choice === WAIT_CHOICE) {
        setWorkingMessage(ctx, "Waiting for IPython kernel...");
        continue;
      }
      if (choice === RESTART_CHOICE) {
        setWorkingMessage(ctx, "Restarting IPython kernel...");
        await runtime.reset();
        kernelRestarted = true;
        continue;
      }
      throw error;
    }
  }
}

function runtimeEnvironment(ctx: ExtensionContext): Record<string, string> {
  const sessionId = ctx.sessionManager.getSessionId();
  const requestDir = join(homedir(), ".pi", "agent", "refinement-requests");
  return {
    PI_SESSION_ID: sessionId,
    PI_SESSION_FILE: ctx.sessionManager.getSessionFile() ?? "",
    PI_REFINEMENT_REQUEST_FILE: join(requestDir, `${sessionId}.json`),
    ...(ctx.model ? { PI_MODEL_SUPPORTS_IMAGES: ctx.model.input.includes("image") ? "1" : "0" } : {}),
  };
}

export default function ipythonExtension(pi: ExtensionAPI) {
  let runtime: IpythonRuntime | undefined;
  let activePythonSkills: DiscoveredPythonSkill[] = [];
  const rendererTracker = new IpythonRendererTracker();

  pi.registerTool({
    name: "ipython",
    label: "ipython",
    description:
      "Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, helper functions, and loaded data persist across calls and are revived on a best-effort basis when a session resumes. Output is limited to 2000 lines or 50KB in model context, with larger output saved to disk.",
    promptSnippet: "Persistent agent notebook for Python scratchpad code and `%%bash` orchestration",
    promptGuidelines: [...IPYTHON_GUIDANCE],
    parameters: IpythonParameters,
    executionMode: "sequential",
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      if (!runtime) {
        activePythonSkills = discoverPythonSkills(ctx.cwd, {
          includeProjectSkills: INCLUDE_PROJECT_PYTHON_SKILLS,
        });
        runtime = new IpythonRuntime({
          cwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId(),
          snapshotDir: artifactDir(ctx),
          pythonSkills: activePythonSkills,
          env: runtimeEnvironment(ctx),
        });
      }

      if (ctx.model) {
        await runtime.setModelSupportsImages(ctx.model.input.includes("image"), signal);
      }

      const spoolPath = outputPath(toolCallId);
      const descriptor = openSync(spoolPath, "w", 0o600);
      let descriptorOpen = true;
      let spoolHasData = false;
      let spoolEndsWithNewline = true;
      let streamedBytes = 0;
      let richOutputBytes = 0;
      const outputLineCounter = new OutputLineCounter();
      const appendSpool = (text: string, asLine: boolean): void => {
        if (!descriptorOpen || text.length === 0) return;
        const prefix = asLine && spoolHasData && !spoolEndsWithNewline ? "\n" : "";
        const suffix = asLine && !text.endsWith("\n") ? "\n" : "";
        const rendered = `${prefix}${text}${suffix}`;
        writeSync(descriptor, Buffer.from(rendered));
        outputLineCounter.feed(rendered);
        spoolHasData = true;
        spoolEndsWithNewline = rendered.endsWith("\n");
      };
      let result: ExecuteResult;
      let kernelRestarted = false;
      let hasWorkingMessage = false;

      const progress = (message: string) => {
        setWorkingMessage(ctx, message);
        hasWorkingMessage = true;
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: { status: "starting" },
        });
      };

      try {
        const execution = await runCell(
          runtime,
          params.code,
          signal,
          (chunk, name) => {
            if (!descriptorOpen) return;
            streamedBytes += Buffer.byteLength(chunk);
            appendSpool(chunk, false);
            onUpdate?.({
              content: [{ type: "text", text: boundField(chunk) ?? "" }],
              details: { status: "ok", [name]: boundField(chunk) },
            });
          },
          (richText, kind) => {
            if (!descriptorOpen) return;
            richOutputBytes += Buffer.byteLength(richText);
            appendSpool(richText, true);
            const bounded = boundField(richText) ?? "";
            onUpdate?.({
              content: [{ type: "text", text: bounded }],
              details: kind === "error"
                ? { status: "error", output: bounded }
                : { status: "ok", [kind]: bounded },
            });
          },
          progress,
          ctx,
        );
        result = execution.result;
        kernelRestarted = execution.kernelRestarted;
      } catch (error) {
        if (descriptorOpen) {
          descriptorOpen = false;
          closeSync(descriptor);
        }
        rmSync(spoolPath, { force: true });
        throw error;
      } finally {
        if (hasWorkingMessage) setWorkingMessage(ctx);
      }
      descriptorOpen = false;
      closeSync(descriptor);

      const rawText = readFileSync(spoolPath, "utf8");
      const rawTruncation = truncateHead(rawText, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });
      const streamWasCapped = streamedBytes > Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      const representedRichBytes =
        Buffer.byteLength(result.display ?? "") +
        Buffer.byteLength(result.result ?? "") +
        Buffer.byteLength(result.error?.traceback.join("\n") ?? "");
      const richOutputWasCapped = richOutputBytes > representedRichBytes;
      const keepSpool = rawTruncation.truncated || streamWasCapped || richOutputWasCapped;
      let truncationNotice: string | undefined;
      if (keepSpool) {
        const bytes = statSync(spoolPath).size;
        truncationNotice = `Output truncated to ${rawTruncation.outputLines} of ${outputLineCounter.value()} lines (${formatSize(rawTruncation.outputBytes)} of ${formatSize(bytes)}). Full output saved to: ${spoolPath}`;
      } else {
        rmSync(spoolPath, { force: true });
      }

      const restore = restoreNotice(runtime);
      const restartNotice = kernelRestarted
        ? "<ipython_kernel_reset>The kernel was restarted. Recreate variables, imports, tasks, and open resources from before the reset.</ipython_kernel_reset>"
        : undefined;
      const notices = [restore.text, restartNotice, truncationNotice].filter(Boolean).join("\n\n");
      const combinedText = [notices, rawText].filter(Boolean).join("\n\n");
      const text = truncateHead(combinedText, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      }).content;
      const details: IpythonToolDetails = {
        durationMs: result.durationMs,
        status: result.status,
        outputLines: outputLineCounter.value(),
        output: boundField(rawText),
        stdout: boundField(result.stdout),
        stderr: boundField(result.stderr),
        display: boundField(result.display),
        result: boundField(result.result),
        diffs: result.diffs,
        attachments: result.attachments?.map((attachment) => ({
          mimeType: attachment.mimeType,
          path: attachment.path,
          bytes: Buffer.from(attachment.data, "base64").byteLength,
        })),
        outputFile: keepSpool ? spoolPath : undefined,
        truncationNotice,
        kernelRestarted,
        restoredNames: restore.restoredNames,
        restoreFailures: restore.restoreFailures,
        error: result.error
          ? {
              ename: result.error.ename,
              evalue: boundField(result.error.evalue) ?? "",
              traceback: (boundField(result.error.traceback.join("\n")) ?? "").split("\n"),
            }
          : undefined,
      };
      const imageContent = (result.attachments ?? [])
        .filter((attachment) => ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(attachment.mimeType))
        .map((attachment) => ({
          type: "image" as const,
          data: attachment.data,
          mimeType: attachment.mimeType,
        }));

      return {
        content: [{ type: "text" as const, text }, ...imageContent],
        details,
        isError: result.status === "error" || result.status === "aborted",
      };
    },

    renderCall(args, theme, context) {
      return renderIpythonCall(args, theme, context, rendererTracker);
    },

    renderResult(result, options, theme, context) {
      return renderIpythonResult(result, options, theme, context, rendererTracker);
    },
  });

  pi.on("before_agent_start", (event) => {
    const selectedTools = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
    const skills = event.systemPromptOptions.skills ?? [];
    if (
      !selectedTools.includes("ipython") ||
      selectedTools.includes("read") ||
      skills.length === 0 ||
      event.systemPrompt.includes("<available_skills>")
    ) return;
    const skillPrompt = formatSkillsForPrompt(skills as Skill[]).replace(
      "Use the read tool to load a skill's file when the task matches its description.",
      "Use ipython Python code, such as pathlib.Path(location).read_text(), to load a skill's file when the task matches its description.",
    );
    if (!skillPrompt) return;
    return { systemPrompt: `${event.systemPrompt}${skillPrompt}` };
  });

  pi.on("session_start", (_event, ctx) => {
    rendererTracker.clear();
    activePythonSkills = discoverPythonSkills(ctx.cwd, {
      includeProjectSkills: INCLUDE_PROJECT_PYTHON_SKILLS,
    });
    runtime = new IpythonRuntime({
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
      snapshotDir: artifactDir(ctx),
      pythonSkills: activePythonSkills,
      env: runtimeEnvironment(ctx),
    });
    runtime.prewarm();

    if (process.env.PI_IPYTHON_KEEP_BUILTINS !== "1") {
      const active = pi.getActiveTools().filter((name) => !LOCAL_BUILTIN_TOOLS.has(name));
      pi.setActiveTools([...new Set([...active, "ipython"])]);
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "ipython") rendererTracker.activate(event.toolCallId);
  });

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    rendererTracker.clear();
    await current?.dispose();
  });

  pi.registerCommand("ipython", {
    description: "Show the persistent IPython kernel status and live namespace",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("IPython runtime is not initialized", "error");
        return;
      }
      setWorkingMessage(ctx, "Inspecting IPython kernel...");
      try {
        const names = await runtime.listNamespaceNames();
        const packages = DEFAULT_PYTHON_PACKAGE_LABELS.join(", ");
        const skills = activePythonSkills.map((skill) => `${skill.name} (${skill.importName})`).join(", ") || "none";
        ctx.ui.notify(
          `IPython ${runtime.isRunning ? "running" : "ready"}\nNames: ${names?.join(", ") || "none"}\nPre-installed: ${packages}\nPython skills: ${skills}`,
          "info",
        );
      } finally {
        setWorkingMessage(ctx);
      }
    },
  });

  pi.registerCommand("ipython-reset", {
    description: "Restart the IPython kernel and clear its in-memory namespace",
    handler: async (_args, ctx) => {
      if (!runtime) return;
      await runtime.reset();
      ctx.ui.notify("IPython kernel reset. The next cell starts a fresh kernel.", "info");
    },
  });
}
