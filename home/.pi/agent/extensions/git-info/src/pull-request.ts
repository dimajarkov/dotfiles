import type { PullRequestInfo } from "../../shared/dashboard-state.ts";
import type { CommandResult } from "./process.ts";

export type PullRequestLookupResult =
  | { readonly kind: "resolved"; readonly pullRequest: PullRequestInfo | null }
  | { readonly kind: "retry" };

function parsePullRequest(value: unknown): PullRequestInfo | null {
  if (typeof value !== "object" || value === null) return null;
  if (!("number" in value) || typeof value.number !== "number") return null;
  if (!("url" in value) || typeof value.url !== "string") return null;
  if (!("state" in value) || value.state !== "OPEN") return null;

  return {
    number: value.number,
    url: value.url,
    isDraft: "isDraft" in value && value.isDraft === true,
  };
}

export function parsePullRequestList(result: CommandResult): PullRequestLookupResult {
  if (result.code !== 0) return { kind: "retry" };

  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value)) return { kind: "retry" };
    if (value.length === 0) return { kind: "resolved", pullRequest: null };

    const pullRequest = parsePullRequest(value[0]);
    return pullRequest
      ? { kind: "resolved", pullRequest }
      : { kind: "retry" };
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
