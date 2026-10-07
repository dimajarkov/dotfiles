import type { PullRequestInfo } from "../../shared/dashboard-state.ts";
import type { CommandResult } from "./process.ts";

export type PullRequestLookupResult =
  | { readonly kind: "resolved"; readonly pullRequest: PullRequestInfo | null }
  | { readonly kind: "retry" };

export function pullRequestViewArgs(branch: string) {
  return ["pr", "view", branch, "--json", "number,url,state,isDraft"];
}

function parsePullRequest(value: unknown): PullRequestLookupResult | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || typeof value.state !== "string") return null;

  if (value.state !== "OPEN") {
    return { kind: "resolved", pullRequest: null };
  }

  return {
    kind: "resolved",
    pullRequest: {
      number: value.number,
      url: value.url,
      isDraft: "isDraft" in value && value.isDraft === true,
    },
  };
}

export function parsePullRequestView(result: CommandResult): PullRequestLookupResult {
  if (result.code !== 0) {
    return /^no (?:open )?pull requests found for branch\b/m.test(result.stderr)
      ? { kind: "resolved", pullRequest: null }
      : { kind: "retry" };
  }

  try {
    return parsePullRequest(JSON.parse(result.stdout)) ?? { kind: "retry" };
  } catch {
    return { kind: "retry" };
  }
}

export function makePullRequestTracker() {
  let activeBranch: string | null = null;
  let resolvedBranch: string | null = null;

  return {
    activate(branch: string | null) {
      const changed = branch !== activeBranch;
      if (changed) {
        activeBranch = branch;
        resolvedBranch = null;
      }
      return changed;
    },
    shouldLookup(branch: string, force: boolean) {
      return force || resolvedBranch !== branch;
    },
    complete(branch: string, result: PullRequestLookupResult) {
      if (activeBranch !== branch) return;
      resolvedBranch = result.kind === "resolved" ? branch : null;
    },
    reset() {
      activeBranch = null;
      resolvedBranch = null;
    },
  };
}
