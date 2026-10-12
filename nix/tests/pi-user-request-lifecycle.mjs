import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { barrier, fixture } from "./pi-user-request-fixture.mjs";

const packages = resolve(process.env.PI_TEST_PACKAGES ?? process.argv[2]);

test(
  "idle input preparation is awaited before every transform and retains native provenance",
  { timeout: 10000 },
  async () => {
    const prepared = barrier(),
      release = barrier(),
      trace = [];
    const f = await fixture(packages, {
      preparation: async (event, ctx) => {
        trace.push(event.type);
        assert.equal(ctx.getUserRequest(), undefined);
        assert.deepEqual(ctx.getUserRequestPreparation(), event.request);
        prepared.release();
        await release.promise;
      },
      factory: (pi) => {
        pi.on("input", () => {
          trace.push("transform");
          return { action: "transform", text: "TRANSFORMED" };
        });
        pi.on("input", (event, ctx) => {
          trace.push("input-work");
          assert.equal(event.text, "TRANSFORMED");
          assert.deepEqual(ctx.getUserRequestPreparation(), event.request);
        });
        pi.on("before_agent_start", (_event, ctx) => {
          trace.push("before_agent_start");
          assert.equal(ctx.getUserRequestPreparation(), undefined);
          assert.equal(ctx.getUserRequest().id, f.inputs[0].request.id);
        });
      },
    });
    const run = f.session.prompt("ORIGINAL");
    try {
      await prepared.promise;
      assert.deepEqual(trace, ["user_request_prepare"]);
      assert.equal(f.calls.length, 0);
      assert.deepEqual(f.inputs, []);
      release.release();
      await run;
      assert.deepEqual(trace, [
        "user_request_prepare",
        "transform",
        "input-work",
        "before_agent_start",
      ]);
      assert.deepEqual(f.preparations[0].request, f.inputs[0].request);
      assert.deepEqual(f.events[0].request, f.inputs[0].request);
      assert.equal(f.context.getUserRequestPreparation(), undefined);
      assert.deepEqual(f.errors, []);
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "pre-request compaction stays inside the fresh awaited response scope",
  { timeout: 10000 },
  async () => {
    const compacted = [];
    const f = await fixture(packages, {
      factory: (pi) => {
        pi.on("session_before_compact", (event, ctx) => {
          compacted.push(ctx.getUserRequest?.()?.id);
          f.session.settingsManager.applyOverrides({ compaction: { enabled: false } });
          return {
            compaction: {
              summary: "SEED SUMMARY",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          };
        });
      },
    });
    try {
      await f.session.prompt("SEED");
      f.session.settingsManager.applyOverrides({
        compaction: { enabled: true, reserveTokens: 999999, keepRecentTokens: 1 },
      });
      await f.session.prompt("AFTER COMPACTION");
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(starts.length, 2);
      assert.deepEqual(compacted, [starts[1].request.id]);
      assert.equal(f.calls.length, 2);
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["completed", "completed"],
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test("request baseline precedes before_agent_start work", { timeout: 10000 }, async () => {
  const boundary = barrier(),
    release = barrier(),
    hook = barrier();
  const f = await fixture(packages, {
    lifecycle: async (event) => {
      if (event.type === "user_request_start") {
        boundary.release();
        await release.promise;
      }
    },
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        hook.release();
      });
    },
  });
  const run = f.session.prompt("BASELINE");
  try {
    await Promise.race([boundary.promise, hook.promise]);
    assert.equal(f.events.length, 1, "the request must start before extension pre-work");
    assert.equal(f.calls.length, 0);
  } finally {
    release.release();
    await run;
    await f.close();
  }
});

test(
  "custom native admission starts a fresh awaited request without input",
  { timeout: 10000 },
  async () => {
    const boundary = barrier(),
      release = barrier();
    const f = await fixture(packages, {
      lifecycle: async (event) => {
        if (event.type === "user_request_start") {
          boundary.release();
          await release.promise;
        }
      },
    });
    try {
      assert.deepEqual(
        f.api.enqueueMessage(
          { customType: "human-feedback", content: "FEEDBACK", display: false },
          { deliverAs: "followUp" },
        ),
        { status: "queued" },
      );
      // Public consumption is observable even on hosts with no lifecycle surface.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.events.length, 1, "custom feedback must acquire its own request baseline");
      await boundary.promise;
      assert.equal(f.calls.length, 0);
      assert.equal(f.inputs.length, 0);
      assert.equal(f.events[0].request.source, "extension");
      assert.equal(f.events[0].request.delivery, "followUp");
      release.release();
      await f.session.waitForIdle();
      assert.deepEqual(
        f.events.map((event) => event.outcome),
        [undefined, "completed"],
      );
    } finally {
      release.release();
      await f.close();
    }
  },
);

test(
  "identical queued requests have distinct awaited response scopes",
  { timeout: 10000 },
  async () => {
    const firstProvider = barrier(),
      releaseProvider = barrier(),
      secondBoundary = barrier(),
      releaseBoundary = barrier();
    const f = await fixture(packages, {
      respond: async (index) => {
        if (index === 0) {
          firstProvider.release();
          await releaseProvider.promise;
        }
      },
      lifecycle: async (event) => {
        if (event.type === "user_request_start" && f.events.length === 3) {
          secondBoundary.release();
          await releaseBoundary.promise;
        }
      },
    });
    const run = f.session.prompt("IDENTICAL");
    try {
      await firstProvider.promise;
      await f.session.prompt("IDENTICAL", { streamingBehavior: "followUp" });
      await f.session.prompt("IDENTICAL", { streamingBehavior: "followUp" });
      assert.equal(
        new Set(f.inputs.map((event) => event.request?.id)).size,
        3,
        "native admission gives each identical input its own identity",
      );
      releaseProvider.release();
      await secondBoundary.promise;
      assert.equal(f.calls.length, 1, "pre-work observation must finish before the next provider");
      releaseBoundary.release();
      await run;
      assert.deepEqual(
        f.events.map((event) => [event.type, event.outcome]),
        [
          ["user_request_start", undefined],
          ["user_request_end", "completed"],
          ["user_request_start", undefined],
          ["user_request_end", "completed"],
          ["user_request_start", undefined],
          ["user_request_end", "completed"],
        ],
      );
      assert.deepEqual(
        f.events
          .filter((event) => event.type === "user_request_start")
          .map((event) => event.request.id),
        f.inputs.map((event) => event.request.id),
      );
      assert.equal(f.calls.length, 3);
      assert.equal(f.context.getUserRequest(), undefined);
      assert.deepEqual(f.errors, []);
    } finally {
      releaseProvider.release();
      releaseBoundary.release();
      await run;
      await f.close();
    }
  },
);

test(
  "transformed identical all-mode inputs share one response and retain every original identity",
  { timeout: 10000 },
  async () => {
    const provider = barrier(),
      release = barrier();
    const f = await fixture(packages, {
      factory: (pi) => pi.on("input", () => ({ action: "transform", text: "TRANSFORMED" })),
      respond: async (index) => {
        if (index === 0) {
          provider.release();
          await release.promise;
        }
      },
    });
    f.session.setFollowUpMode("all");
    const run = f.session.prompt("first", { source: "rpc" });
    try {
      await provider.promise;
      await f.session.followUp("second", undefined, { source: "rpc" });
      await f.session.followUp("second", undefined, { source: "rpc" });
      release.release();
      await run;
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(f.calls.length, 2, "explicit all mode sends both queued inputs in one response");
      assert.equal(starts.length, 2);
      const group = starts[1].request;
      assert.equal(group.mode, "all");
      assert.deepEqual(
        group.requests,
        f.inputs.slice(1).map((event) => event.request),
      );
      assert.equal(
        new Set([starts[0].request.id, group.id, ...group.requests.map((r) => r.id)]).size,
        4,
      );
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end"),
        [
          { type: "user_request_end", request: starts[0].request, outcome: "completed" },
          { type: "user_request_end", request: group, outcome: "completed" },
        ],
      );
      assert.deepEqual(
        f.calls[1].messages
          .filter((message) => message.role === "user")
          .map((message) => message.content[0].text),
        ["TRANSFORMED", "TRANSFORMED", "TRANSFORMED"],
      );
      assert.deepEqual(f.session.getFollowUpMessages(), []);
      assert.ok(
        f.calls.every((context) =>
          context.messages
            .filter((message) => message.role === "user")
            .every(
              (message) => message.content[0].text === "TRANSFORMED" && !("userRequest" in message),
            ),
        ),
      );
      const phases = f.session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "custom" && entry.customType === "pi.user-request");
      assert.equal(phases.filter((entry) => entry.data.phase === "admitted").length, 3);
      assert.equal(phases.filter((entry) => entry.data.phase === "end").length, 2);
      assert.ok(phases.every((entry) => !JSON.stringify(entry.data).includes("TRANSFORMED")));
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "all-mode context contributions preserve batch order without becoming group members",
  { timeout: 10000 },
  async () => {
    const provider = barrier(),
      release = barrier();
    const f = await fixture(packages, {
      respond: async (index) => {
        if (index === 0) {
          provider.release();
          await release.promise;
        }
      },
    });
    f.session.setFollowUpMode("all");
    const run = f.session.prompt("FIRST");
    const context = (content) => ({
      role: "custom",
      customType: "context",
      content,
      display: false,
      timestamp: 0,
    });
    try {
      await provider.promise;
      // Public agent-core queue entries without provenance contribute context rather than creating a request.
      f.session.agent.followUp(context("CONTEXT BEFORE"));
      await f.session.followUp("NEXT");
      f.session.agent.followUp(context("CONTEXT AFTER"));
      await f.session.followUp("LAST");
      release.release();
      await run;
      assert.equal(
        f.calls.length,
        2,
        "untagged context must not create an extra provider response",
      );
      const next = JSON.stringify(f.calls[1].messages);
      assert.ok(
        next.includes("CONTEXT BEFORE") && next.includes("NEXT") && next.includes("CONTEXT AFTER"),
      );
      assert.ok(next.includes("LAST"));
      const texts = f.calls[1].messages
        .filter((message) => message.role === "user")
        .map((message) => message.content[0].text);
      assert.deepEqual(texts, ["FIRST", "CONTEXT BEFORE", "NEXT", "CONTEXT AFTER", "LAST"]);
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(starts.length, 2);
      assert.deepEqual(
        starts[1].request.requests,
        f.inputs.slice(1).map((event) => event.request),
      );
      assert.deepEqual(f.errors, []);
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "tools, retry, and automatic settlement continuation stay in one response before queued work",
  { timeout: 10000 },
  async () => {
    const provider = barrier(),
      release = barrier(),
      scopes = [],
      tools = [];
    let continued = false;
    const f = await fixture(packages, {
      settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
      factory: (pi) => {
        pi.registerTool({
          name: "observe",
          label: "Observe",
          description: "Local fixture tool",
          parameters: { type: "object", properties: {} },
          execute: async (_id, _params, _signal, _update, ctx) => {
            tools.push(ctx.getUserRequest().id);
            return { content: [{ type: "text", text: "OBSERVED" }], details: {} };
          },
        });
        pi.on("agent_before_settle", () => {
          if (continued) return;
          continued = true;
          return {
            entries: [
              {
                type: "custom_message",
                customType: "automatic",
                content: "CONTINUE",
                display: false,
              },
            ],
            continue: true,
          };
        });
      },
      respond: async (index) => {
        scopes.push(f.context.getUserRequest().id);
        if (index === 0) {
          provider.release();
          await release.promise;
          return {
            content: [{ type: "toolCall", id: "fixture-tool", name: "observe", arguments: {} }],
            stopReason: "toolUse",
          };
        }
        if (index === 1) return { stopReason: "error", errorMessage: "429 rate limit" };
      },
    });
    f.session.setActiveToolsByName(["observe"]);
    const run = f.session.prompt("WITH TOOLS");
    try {
      await provider.promise;
      await f.session.followUp("NEXT");
      release.release();
      await run;
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(starts.length, 2);
      assert.deepEqual(scopes, [
        starts[0].request.id,
        starts[0].request.id,
        starts[0].request.id,
        starts[0].request.id,
        starts[1].request.id,
      ]);
      assert.deepEqual(tools, [starts[0].request.id]);
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["completed", "completed"],
      );
      assert.deepEqual(f.errors, []);
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "steering supersedes the prior scope after tools; terminal failure is explicit",
  { timeout: 10000 },
  async () => {
    const tool = barrier(),
      release = barrier(),
      scopes = [];
    const f = await fixture(packages, {
      factory: (pi) =>
        pi.registerTool({
          name: "gated",
          label: "Gated",
          description: "Fixture",
          parameters: { type: "object", properties: {} },
          execute: async () => {
            tool.release();
            await release.promise;
            return { content: [{ type: "text", text: "DONE" }], details: {} };
          },
        }),
      respond: async (index) => {
        scopes.push(f.context.getUserRequest().id);
        if (index === 0)
          return {
            content: [{ type: "toolCall", id: "gate", name: "gated", arguments: {} }],
            stopReason: "toolUse",
          };
        return { stopReason: "error", errorMessage: "Terminal fixture failure" };
      },
    });
    f.session.setActiveToolsByName(["gated"]);
    const run = f.session.prompt("ORIGINAL");
    try {
      await tool.promise;
      await f.session.steer("STEERING");
      assert.equal(f.events.length, 1, "executing tools still belong to the original scope");
      release.release();
      await run;
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["interrupted", "failed"],
      );
      assert.equal(new Set(scopes).size, 2);
      assert.equal(f.session.userRequest, undefined);
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "queue admission retains identity when asynchronous input changes busy state",
  { timeout: 10000 },
  async () => {
    const transforming = barrier(),
      transform = barrier(),
      provider = barrier(),
      release = barrier();
    const f = await fixture(packages, {
      factory: (pi) =>
        pi.on("input", async (event) => {
          if (event.text !== "SLOW") return;
          transforming.release();
          await transform.promise;
          return { action: "transform", text: "TRANSFORMED" };
        }),
      respond: async (index) => {
        if (index === 0) {
          provider.release();
          await release.promise;
        }
      },
    });
    const slow = f.session.prompt("SLOW", { streamingBehavior: "steer" });
    await transforming.promise;
    const run = f.session.prompt("ACTIVE");
    try {
      await provider.promise;
      transform.release();
      await slow;
      release.release();
      await run;
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(starts[1].request.id, f.inputs[0].request.id);
      assert.equal(starts[1].request.delivery, "steer");
      assert.deepEqual(f.session.getSteeringMessages(), []);
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["interrupted", "completed"],
      );
      assert.deepEqual(f.errors, []);
    } finally {
      transform.release();
      release.release();
      await slow;
      await run;
      await f.close();
    }
  },
);

test("abort closes the active response as interrupted", { timeout: 10000 }, async () => {
  const provider = barrier();
  const f = await fixture(packages, {
    respond: async (_index, _context, options) => {
      provider.release();
      await new Promise((resolve) =>
        options.signal.addEventListener("abort", resolve, { once: true }),
      );
      return { stopReason: "aborted" };
    },
  });
  const run = f.session.prompt("ABORT");
  try {
    await provider.promise;
    await f.session.abort();
    await run;
    assert.deepEqual(
      f.events.map((event) => event.outcome),
      [undefined, "interrupted"],
    );
  } finally {
    await run;
    await f.close();
  }
});

test(
  "an unrecovered runtime failure closes the request as failed",
  { timeout: 10000 },
  async () => {
    const f = await fixture(packages, {
      factory: (pi) =>
        pi.on("agent_before_settle", () => ({
          entries: [
            {
              type: "custom_message",
              customType: "settlement",
              content: "CONTEXT",
              display: false,
            },
          ],
        })),
    });
    f.session.subscribe((event) => {
      if (event.type === "entry_appended") throw new Error("fixture terminal observer failure");
    });
    try {
      await assert.rejects(f.session.prompt("WORK"), /fixture terminal observer failure/);
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["failed"],
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "final request notification finishes before the next queued request starts",
  { timeout: 10000 },
  async () => {
    const ending = barrier(),
      release = barrier();
    let ended = false;
    const f = await fixture(packages, {
      lifecycle: async (event) => {
        if (event.type === "user_request_end" && !ended) {
          ended = true;
          ending.release();
          await release.promise;
        }
      },
    });
    // Public followUp queues without starting a provider; it must wait through the final boundary.
    await f.session.followUp("QUEUED");
    const run = f.session.prompt("FIRST");
    try {
      await ending.promise;
      assert.equal(f.calls.length, 1);
      assert.equal(f.events.filter((event) => event.type === "user_request_start").length, 1);
      release.release();
      await run;
      assert.equal(f.calls.length, 2);
      assert.deepEqual(
        f.events.filter((event) => event.type === "user_request_end").map((event) => event.outcome),
        ["completed", "completed"],
      );
    } finally {
      release.release();
      await run;
      await f.close();
    }
  },
);

test(
  "repeated custom correlations retain fresh native identities and settled admission creates no empty response",
  { timeout: 10000 },
  async () => {
    let admitted = false;
    const f = await fixture(packages, {
      factory: (pi) =>
        pi.on("agent_settled", () => {
          if (admitted) return;
          admitted = true;
          for (let i = 0; i < 2; i++)
            assert.deepEqual(
              pi.enqueueMessage(
                { customType: "custom-request", content: "IDENTICAL", display: false },
                { deliverAs: "followUp", correlationId: "same-submitter-reference" },
              ),
              { status: "queued" },
            );
        }),
    });
    try {
      await f.session.prompt("FIRST");
      const starts = f.events.filter((event) => event.type === "user_request_start");
      assert.equal(starts.length, 3);
      assert.equal(new Set(starts.map((event) => event.request.id)).size, 3);
      assert.deepEqual(
        starts.slice(1).map((event) => event.request.correlationId),
        ["same-submitter-reference", "same-submitter-reference"],
      );
      assert.equal(f.calls.length, 3);
      assert.equal(f.session.isIdle, true);
      assert.equal(f.context.hasPendingMessages(), false);
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

for (const delivery of ["followUp", "steer"]) {
  test(
    `explicit all-mode ${delivery} group retains tools, retry, continuation and correlations`,
    { timeout: 10000 },
    async () => {
      const provider = barrier(),
        release = barrier(),
        groupBoundary = barrier(),
        groupRelease = barrier();
      const scopes = [],
        tools = [];
      let continued = false;
      const f = await fixture(packages, {
        settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
        lifecycle: async (event, ctx) => {
          if (event.type === "user_request_start" && "requests" in event.request) {
            assert.deepEqual(ctx.getUserRequest(), event.request);
            groupBoundary.release();
            await groupRelease.promise;
          }
        },
        factory: (pi) => {
          pi.registerTool({
            name: "group_tool",
            label: "Group tool",
            description: "Offline group fixture",
            parameters: { type: "object", properties: {} },
            execute: async (_id, _params, _signal, _update, ctx) => {
              tools.push(structuredClone(ctx.getUserRequest()));
              return { content: [{ type: "text", text: "TOOL DONE" }], details: {} };
            },
          });
          pi.on("agent_before_settle", (_event, ctx) => {
            if (continued || !ctx.getUserRequest()?.requests) return;
            continued = true;
            return {
              entries: [
                {
                  type: "custom_message",
                  customType: "automatic",
                  content: "AUTOMATIC CONTEXT",
                  display: false,
                },
              ],
              continue: true,
            };
          });
        },
        respond: async (index) => {
          scopes.push(structuredClone(f.session.userRequest));
          if (index === 0) {
            provider.release();
            await release.promise;
          }
          if (index === 1)
            return {
              content: [{ type: "toolCall", id: "group-tool", name: "group_tool", arguments: {} }],
              stopReason: "toolUse",
            };
          if (index === 2) return { stopReason: "error", errorMessage: "429 rate limit" };
        },
      });
      f.session.setActiveToolsByName(["group_tool"]);
      f.session.setFollowUpMode("all");
      f.session.setSteeringMode("all");
      const run = f.session.prompt("FIRST");
      try {
        await provider.promise;
        for (let i = 0; i < 2; i++)
          assert.deepEqual(
            f.api.enqueueMessage(
              { customType: "group-feedback", content: "IDENTICAL CUSTOM", display: false },
              { deliverAs: delivery, correlationId: "shared-reference" },
            ),
            { status: "queued" },
          );
        release.release();
        await groupBoundary.promise;
        assert.equal(
          f.calls.length,
          1,
          "group work must wait for the awaited whole-group baseline",
        );
        groupRelease.release();
        await run;
        const starts = f.events.filter((event) => event.type === "user_request_start");
        const group = starts[1].request;
        assert.equal(starts.length, 2);
        assert.equal(group.requests.length, 2);
        assert.equal(new Set(group.requests.map((r) => r.id)).size, 2);
        assert.deepEqual(
          group.requests.map(({ source, delivery: route, correlationId }) => [
            source,
            route,
            correlationId,
          ]),
          [
            ["extension", delivery, "shared-reference"],
            ["extension", delivery, "shared-reference"],
          ],
        );
        assert.deepEqual(scopes, [starts[0].request, group, group, group, group]);
        assert.deepEqual(tools, [group]);
        assert.deepEqual(
          f.events
            .filter((e) => e.type === "user_request_end")
            .map((e) => [e.request.id, e.outcome]),
          [
            [starts[0].request.id, delivery === "steer" ? "interrupted" : "completed"],
            [group.id, "completed"],
          ],
        );
        assert.deepEqual(f.errors, []);
      } finally {
        release.release();
        groupRelease.release();
        await run;
        await f.close();
      }
    },
  );
}
