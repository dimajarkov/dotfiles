import assert from "node:assert/strict";
import test from "node:test";
import {
  makePullRequestTracker,
  parsePullRequestView,
  pullRequestViewArgs,
} from "./src/pull-request.ts";

test("PR lookup addresses the requested branch directly", () => {
  assert.deepEqual(pullRequestViewArgs("feature/topic"), [
    "pr",
    "view",
    "feature/topic",
    "--json",
    "number,url,state,isDraft",
  ]);
});

test("failed PR lookup remains eligible for a retry on the same branch", () => {
  const tracker = makePullRequestTracker();

  assert.equal(tracker.activate("feature"), true);
  assert.equal(tracker.shouldLookup("feature", false), true);
  tracker.complete("feature", { kind: "retry" });

  assert.equal(tracker.activate("feature"), false);
  assert.equal(tracker.shouldLookup("feature", false), true);

  tracker.complete("feature", { kind: "resolved", pullRequest: null });
  assert.equal(tracker.shouldLookup("feature", false), false);
});

test("PR view results distinguish closed PRs from command or parse failures", () => {
  assert.deepEqual(
    parsePullRequestView({ code: 1, stderr: "temporary failure", stdout: "" }),
    { kind: "retry" },
  );
  assert.deepEqual(
    parsePullRequestView({
      code: 1,
      stderr: 'no pull requests found for branch "feature"',
      stdout: "",
    }),
    { kind: "resolved", pullRequest: null },
  );
  assert.deepEqual(
    parsePullRequestView({
      code: 0,
      stderr: "",
      stdout: '{"number":12,"url":"https://github.com/o/r/pull/12","state":"CLOSED"}',
    }),
    { kind: "resolved", pullRequest: null },
  );
  assert.deepEqual(
    parsePullRequestView({ code: 0, stderr: "", stdout: "invalid" }),
    { kind: "retry" },
  );
  assert.deepEqual(
    parsePullRequestView({
      code: 0,
      stderr: "",
      stdout: '{"number":12,"url":"https://github.com/o/r/pull/12","state":"OPEN","isDraft":true}',
    }),
    {
      kind: "resolved",
      pullRequest: {
        number: 12,
        url: "https://github.com/o/r/pull/12",
        isDraft: true,
      },
    },
  );
});
