import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Usage = {
  cost: { total: number };
};

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
  const home = resolve(homedir());
  const resolvedCwd = resolve(cwd);
  const relativeToHome = relative(home, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function getCost(ctx: ExtensionContext): number {
  let cost = 0;
  const addUsage = (usage: Usage) => {
    cost += usage.cost.total;
  };

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      addUsage(entry.message.usage);
    } else if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.usage
    ) {
      addUsage(entry.message.usage);
    } else if (
      (entry.type === "branch_summary" || entry.type === "compaction") &&
      entry.usage
    ) {
      addUsage(entry.usage);
    }
  }

  return cost;
}

function layoutRow(left: string, right: string, width: number): string {
  const gap = 3;
  const leftWidth = visibleWidth(left);
  const rightWidth = visibleWidth(right);

  if (leftWidth + gap + rightWidth <= width) {
    return left + " ".repeat(width - leftWidth - rightWidth) + right;
  }

  const rightBudget = Math.max(0, Math.min(rightWidth, width - gap));
  const leftBudget = width - gap - rightBudget;
  if (leftBudget > 0 && rightBudget > 0) {
    const fittedLeft = truncateToWidth(left, leftBudget, "…");
    const fittedRight = truncateToWidth(right, rightBudget, "");
    return (
      fittedLeft +
      " ".repeat(Math.max(0, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight))) +
      fittedRight
    );
  }

  return truncateToWidth(leftWidth > rightWidth ? left : right, width, "…");
}

function usesSubscription(provider: string | undefined): boolean {
  return (
    provider === "openai-codex" ||
    provider === "github-copilot" ||
    provider === "kimi-coding"
  );
}

export default function (pi: ExtensionAPI) {
  let requestRender: (() => void) | undefined;
  let installFooter: (() => void) | undefined;
  let currentModel: ExtensionContext["model"];

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model;

    const createFooter = () => {
      ctx.ui.setFooter((tui, theme, footerData) => {
        requestRender = () => tui.requestRender();
        const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

        return {
          dispose: () => {
            unsubscribe();
            requestRender = undefined;
          },
          invalidate() {},
          render(width: number): string[] {
            if (width <= 0) return [];

            const cwd = formatCwd(ctx.sessionManager.getCwd());
            const branch = footerData.getGitBranch();
            const location = branch
              ? `${theme.fg("text", theme.bold(cwd))}${theme.fg("muted", `  ·  ⎇ ${branch}`)}`
              : theme.fg("text", theme.bold(cwd));

            const subscription = usesSubscription(currentModel?.provider);
            const cost = `$${getCost(ctx).toFixed(3)}${subscription ? " (sub)" : ""}`;
            const contextUsage = ctx.getContextUsage();
            const contextWindow =
              contextUsage?.contextWindow ?? currentModel?.contextWindow ?? 0;
            const contextPercent = contextUsage?.percent;
            const context = `${formatTokens(contextWindow)} (${
              contextPercent === null || contextPercent === undefined
                ? "?"
                : `${contextPercent.toFixed(1)}%`
            })`;

            const model = currentModel?.id ?? "unknown";
            const modelStatus = theme.fg(
              "muted",
              `${model} · ${pi.getThinkingLevel()}`,
            );

            return [
              truncateToWidth(location, width, "…"),
              layoutRow(
                `${theme.fg("muted", cost)}  ${modelStatus}`,
                theme.fg("muted", context),
                width,
              ),
            ];
          },
        };
      });
    };

    installFooter = createFooter;
    createFooter();
  });

  const refresh = () => {
    installFooter?.();
    requestRender?.();
  };

  pi.on("resources_discover", refresh);
  pi.on("agent_start", refresh);
  pi.on("before_agent_start", refresh);
  pi.on("session_info_changed", refresh);
  pi.on("thinking_level_select", refresh);

  pi.on("model_select", (event) => {
    currentModel = event.model;
    installFooter?.();
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
    installFooter = undefined;
    requestRender = undefined;
  });
}
