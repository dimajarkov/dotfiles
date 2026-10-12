# Pi user-request lifecycle

The accepted policy preserves Pi's explicit `all` queue batching and labels its one actual response as an intentional group review.
Ordinary one-at-a-time queues retain an independent review for each admitted request.
Apply `nix/patches/pi-native-message-admission.patch` first, then `nix/patches/pi-user-request-lifecycle.patch` to pinned Pi commit `abe508e1b89912adde45528136c3221eb69acdd7`.
Main owns package wiring, installation, activation, final trust/reviews, and end-user visual acceptance.
This implementation changes neither the original `handovers` session nor its processes.
Slot 13 remains durably leased for `hunk-turn-review`.

## Public native contract

`UserRequest`, `UserRequestGroup`, and `UserRequestScope` are exported by `@earendil-works/pi-agent-core` and `@earendil-works/pi-coding-agent`.
A `UserRequest` has readonly `{id:string,source:string,delivery:"prompt"|"steer"|"followUp",correlationId?:string}` fields.
Pi allocates a fresh UUID before input transformation and retains it through expansion, queue admission, consumption, and its response.
`InputEvent.request` supplies this same identity even when repeated or transformed text is identical.
Its declaration is optional for extension-created legacy input events; native session input always supplies it.
An asynchronous input transform can change actual routing without changing the original ID or source.
The input event describes planned delivery, while admission and start records describe actual delivery.
Provenance contains neither prompt text nor timestamp matching.

`user_request_prepare` is an awaited observation barrier before an idle `prompt()` runs any input handler, transformation, skill expansion, or template expansion.
Its `{type:"user_request_prepare",request:UserRequest}` notification arms an interval without changing streaming state, queue selection, or `ctx.getUserRequest()`.
`ctx.getUserRequestPreparation()` exposes that interval until it transfers to an actual response or ends.
The getter is optional for extension-created legacy contexts; its presence, together with `getUserRequest()`, is the first-edit capability check.
Busy input does not create another preparation interval or replace the active response baseline.
Asynchronous input retains upstream routing: another request can start while an earlier input transform waits.
When that actual response inherits an earlier preparation interval, `UserRequestStartEvent.preparationId` explicitly identifies the original native request ID to bind without recapturing the baseline.
Same-ID start remains idempotent.
Handled input, abort, and rejected preflight end an unconsumed interval through awaited `user_request_prepare_end` with `{request,outcome:"completed"|"interrupted"|"failed"}`.
These outcomes describe extension preparation work without manufacturing a model response or a queue-admission receipt.
Extension commands and queue-only `steer()`/`followUp()` calls retain their upstream semantics.

`UserRequestGroup` has readonly `{id:string,mode:"all",requests:readonly UserRequest[]}` fields.
Its fresh response-scope UUID differs from every original member UUID.
The ordered members preserve their original IDs, sources, actual delivery, and optional custom correlation references.
`UserRequestScope` is `UserRequest | UserRequestGroup`.
A group represents one actual response to an intentional selected batch, rather than several independently authored responses or member-specific diffs.

`pi.on("user_request_start", async (event, ctx) => ...)` receives `{type:"user_request_start",request:UserRequestScope}`.
Pi awaits notification handlers before selected-response preparation, model work, or tools for the complete selected scope.
Idle prompt input work is covered by the earlier preparation barrier.
`pi.on("user_request_end", async (event, ctx) => ...)` receives `{type:"user_request_end",request:UserRequestScope,outcome:"completed"|"interrupted"|"failed"}`.
Pi awaits them after tools, retries, recovery, automatic continuation, and final actionable settlement, before the next queued response starts work.
The events are notifications and cannot request continuation; ordinary handler errors follow the native extension error-reporting policy.
`ctx.getUserRequest()` and `session.userRequest` expose the active scope, or undefined outside a response.
SDK session subscribers observe both events through their existing notification-only subscription contract.
The context getter is optional in declarations for externally constructed contexts, while the patched native runtime always supplies it.
Exact first-edit coverage additionally requires the preparation getter.

`pi.enqueueMessage()` retains synchronous admission and the exact `{status:"queued"}` receipt.
Triggered custom messages create fresh extension-origin requests even when no `input` event occurs.
The optional `correlationId` admission option preserves a caller-owned reference separately from the native UUID.
Repeated correlations never imply deduplication or reused native identity.
Context-only custom messages, `nextTurn` messages, boundary entries, tools, retries, and internal continuations do not create additional requests.
Session-owned `pi.user-request` custom metadata entries record admitted/start/end phases outside model context.
Admission records do not prove consumption or successful completion, and native queues remain memory-only.

## Selection and outcomes

Queue selection, message order, and model-facing batching follow the configured SDK mode unchanged.
An explicit `all` selection containing at least two distinct tagged requests starts one group scope and publishes one actual group outcome.
A selection containing one tagged request uses that individual's scope.
Untagged context contributions retain their position in the selected model input without becoming members.
No separate completed outcomes are manufactured for group members.

A follow-up waits for the current scope's automatic work and actionable settlement hooks.
Interactive steering is consumed after the current assistant/tool batch and supersedes the previous scope as interrupted.
Already executing tools finish at their ordinary steering boundary.
Abort publishes interrupted; a terminal unrecovered provider or runtime error publishes failed.
These outcomes apply to the whole actual group when a group is active.

The generic agent-core `beforeInput(messages,signal?)` barrier is awaited before selected input preparation and compaction.
`AgentOptions.beforeInput`, `Agent.beforeInput`, and `AgentLoopConfig.beforeInput` share that callback contract.
Native `AgentSession` enables the generic `deferFollowUp` scheduling option so it can perform recovery and settlement before draining follow-ups.
Direct agent-core consumers keep the default scheduling unless they select that option.
The queue's existing `all` and one-at-a-time selection implementation is unchanged.

## Hunk integration

The native Pi adapter requires both public lifecycle getters for exact response reviews.
At `user_request_prepare`, it awaits core `request.begin` before input work.
At `user_request_start`, ordinary `request.begin` is idempotent for that same native ID and keeps the original baseline.
An explicit `preparationId` instead uses `request.bind` to transfer the original interval to the actual selected native scope.
`user_request_prepare_end` completes input-only work with its explicit outcome and releases the interval.
Feedback admission checks also refuse an outstanding native preparation interval, even though upstream input routing still considers the model idle.
For an individual scope, the ordinary label remains `changes observed during this response`.
For a group, it supplies `requestGroup:{mode:"all",requests:[{id,source,delivery,correlationId?}]}`.
Core retains the first baseline for the entire group and publishes one immutable review using the actual completed, interrupted, or failed outcome.

Explicit feedback keeps its immutable batch ID independently from the native UUID.
If core already prearmed the feedback interval, the adapter finds the exact extension member correlation and awaits `request.bind` before corrective work.
Binding adds group metadata without recapturing or replacing the first baseline.
Core refuses duplicate member IDs, a member ID equal to the scope ID, and an idempotent begin that changes the active group.

`review.get` includes structured `requestGroup` on a grouped response.
`review.status.active.requestGroup` and `review.status.latestRequestGroup` expose active and latest group provenance.
The label is `changes observed during intentional Pi all-mode group: N user requests`.
The existing public snapshot adapter already includes `review.label`, actual outcome, and immutable review ID in its title.
The actual SDK-to-core test verifies that title without changing UI or source Hunk.
Cumulative task reviews omit `requestGroup` because they span multiple response scopes.
Earlier reviews, saved notes, pins, and immutable feedback context remain bound to their original snapshot.

Original TUI/Herdr gating, canonical Git-root identity, native UUID/path/epoch revalidation, synchronous admission, and final non-steering delivery remain enforced.
An older host produces a compatibility warning and leaves exact response review disabled.
This includes the earlier lifecycle host that exposes `getUserRequest()` but starts observation after input hooks.

## Regression reconciliation

The two existing upstream tests for explicit `all` batching now pass with their original shared-response assertions unchanged.
The follow-up handoff characterization now checks that the handoff remains in the current automatic continuation while the queued external follow-up receives its own response scope.
Its original steering and combined steering/follow-up assertions remain intact.
Exact retry event lists add awaited preparation and request-start/end notifications while preserving their original event ordering assertions.
Bash persistence tests retain exact message-content assertions and add explicit admitted/start/end metadata assertions, including interrupted abort provenance.
These changes are maintained in the lifecycle patch, rather than resetting expected behavior to the current implementation without explanation.

The admission patch already supplies the missing `ExtensionActions.enqueueMessage` test stub.
The entire declared upstream `npm run check`, including full `tsc --noEmit`, now passes.
No admission behavior or admission test assertion was changed by this lifecycle implementation.

## Verification

The deterministic provider replaces only the external model seam.
Tests construct actual public SDK sessions, queue state, extension runtimes, native events, and core socket commands.
The PTY proof uses an isolated real Pi process; full core tests use separate named Herdr sessions and private checkouts/state.
Original live sessions are outside those fixtures.

From the repo root:

```sh
PI_OFFLINE=1 node nix/tests/pi-user-request-lifecycle.mjs <built-package>/lib/pi-coding-agent/packages
PI_OFFLINE=1 node nix/tests/pi-message-admission.mjs <built-package>/lib/pi-coding-agent/packages
PI_OFFLINE=1 PI_TEST_PACKAGES=<built-packages> PI_OLD_TEST_PACKAGES=<older-packages> bun test tests/pi-hunk-request-lifecycle.test.ts
nix build path:.#hunk-turn-review --out-link <task-private-dir>/profile --print-out-paths
```

Nix references `${../tests}/pi-user-request-lifecycle.mjs` so its sibling `pi-user-request-fixture.mjs` import remains available.
Main's existing Nix asset build typechecks the Pi adapter against the built Pi package's public `dist/index.d.ts`.
Local strict checks use an ephemeral configuration with the same public declaration mapping; no store path or source-worktree mapping is committed to a tsconfig.

The final upstream offline regression command is:

```sh
# From the pinned mutable source's packages/coding-agent directory.
PI_OFFLINE=1 node ../../node_modules/vitest/dist/cli.js --run \
  test/suite/agent-session-queue.test.ts \
  test/suite/agent-session-boundaries.test.ts \
  test/suite/agent-session-compaction.test.ts \
  test/suite/agent-session-compaction-model-overrides.test.ts \
  test/suite/agent-session-retry-events.test.ts \
  test/suite/agent-session-bash-persistence.test.ts \
  test/agent-session-compaction.test.ts \
  test/agent-session-auto-compaction-queue.test.ts \
  test/agent-session-retry.test.ts \
  test/extensions-input-event.test.ts \
  test/extensions-runner.test.ts
# From packages/agent.
PI_OFFLINE=1 npm test
# From the source root.
PI_OFFLINE=1 npm run check
```

## P1 first-edit regression proof, 2026-10-12

Before this fix, the actual installed SDK reproduction transformed input, wrote `INPUT PREPARATION` from the next `input` handler, and received a completed Hunk review with `changes:[]`.
The original tracked file already contained `PREEXISTING`, so capturing the baseline after the hook also lost the cumulative task baseline.
The original tight command was `bun test tests/pi-hunk-request-lifecycle.test.ts --test-name-pattern 'first input-hook edit'` with `PI_TEST_PACKAGES` pointing to `/nix/store/a9hfqcdwmq2vvl7gsp60x88g74ggqah5-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages` and `HUNK_REVIEW_TEST_RUNTIME` pointing to the original rooted profile's real packaged runtime.
The repository adapter was byte-identical to that installed adapter at reproduction time.
It failed with `Expected length: 1; Received length: 0` in about 0.6 seconds.
The cause was the native start barrier running after `_runInputHandlers`, before which Hunk had no observation interval.

The fixed tests use the actual SDK, extension runner, deterministic external model seam, maintained adapter, and packaged core socket commands.
Both input-handler registration orders retain `PREEXISTING` as the response and task baseline and include the preparatory write.
Read-only and handled read-only input leave no task baseline or layout state.
Handled writes, rejected preflight writes, and canceled input writes publish completed, failed, and interrupted outcomes respectively, without a fictitious native response or leftover interval.
Busy hook writes retain the prior active baseline, and queued requests start only at their actual consumption boundary.
An asynchronous transform changing routing binds the original interval through explicit provenance.
The feedback regression writes before the adapter's native start handler and verifies that batch-to-native-ID binding still retains the prearmed batch baseline.
The existing intentional `all`, tools, retries, automatic continuation, steering, and immutable feedback regressions retain their original behavior assertions.
Only two upstream exact event lists needed an additional preparation notification; message, queue, and batching assertions were preserved.

| Current scoped check | Result |
| --- | --- |
| Built Pi admission install checks | 13/13 pass |
| Built public SDK lifecycle install checks | 16/16 pass |
| Packaged SDK-to-Hunk suite, including unpatched and late-start legacy hosts | 22/22 pass, 167 assertions |
| Relevant upstream native session and extension suite | 189 pass, five credential-dependent e2e skips |
| Entire upstream agent-core suite | 91/91 pass |
| Entire upstream declared `npm run check` | Pass, including TypeScript and Biome |
| Packaged core checkpoint/snapshot suite plus actual Pi PTY | 24/24 pass, 191 assertions |
| Public Pi declarations, core and adapter typechecks | Pass |
| Scoped Oxc lint and formatting | Pass |
| Full default feature-profile Nix build | Pass, including adapter/public declaration checks and packaged review/control artifact checks |

## Rooted build and exact rerun commands

The final task-private GC root is `/private/tmp/pi-input-baseline.49ijTP/profile`.
It points to `/nix/store/v7ddssw5ak0pw8mcxi7wdpixmr2dfb31-hunk-turn-review-profile-1.0.0`.
The profile uses `/nix/store/p3zw95m9ssigfcgc708y2jvvvsjm5wwc-pi-coding-agent-1.1.0` and `/nix/store/ya7316cm63r5asi6w7fv8bgldh943f93-hunk-turn-review-assets-1.0.0`.
Its installed Pi adapter matches the repository adapter byte-for-byte.
The pinned source was copied from the actual Pi derivation's source, native admission was applied first, and the lifecycle patch was generated against that admission-only baseline.
GNU `patch --fuzz=0` applied both patches in order on another pristine copy, and all 14 lifecycle-patched files matched the tested mutable source.
The lifecycle patch applied without offsets or fuzz; admission's existing offsets required no behavior or patch changes.
No admission patch or Nix package file was edited in this fix.
The previous default-build context blocker is resolved in the parent-owned admission patch; this proof used the current default package wiring without a temporary override.

From slot 13's repo root:

```sh
nix build path:.#hunk-turn-review \
  --out-link /private/tmp/pi-input-baseline.49ijTP/profile --print-out-paths

export PI_TEST_BIN=/private/tmp/pi-input-baseline.49ijTP/profile/bin/pi
export PI_TEST_PACKAGES=/nix/store/p3zw95m9ssigfcgc708y2jvvvsjm5wwc-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages
export PI_OLD_TEST_PACKAGES=/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages
export PI_PREPARATION_OLD_TEST_PACKAGES=/nix/store/a9hfqcdwmq2vvl7gsp60x88g74ggqah5-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages
export HUNK_REVIEW_TEST_RUNTIME=/nix/store/ya7316cm63r5asi6w7fv8bgldh943f93-hunk-turn-review-assets-1.0.0/share/home/.local/share/hunk-turn-review/dist/runtime.js
export HUNK_TURN_REVIEW_TEST_RUNTIME="$HUNK_REVIEW_TEST_RUNTIME"

PI_OFFLINE=1 bun test tests/pi-hunk-request-lifecycle.test.ts
PI_OFFLINE=1 node nix/tests/pi-user-request-lifecycle.mjs "$PI_TEST_PACKAGES"
PI_OFFLINE=1 node nix/tests/pi-message-admission.mjs "$PI_TEST_PACKAGES"

cd home/.local/share/hunk-turn-review
PI_OFFLINE=1 bun test tests/runtime.test.ts tests/pi-native.test.ts
node typecheck-pi-adapter.mjs
```

The final relevant upstream session command listed above ran from `/private/tmp/pi-input-baseline.49ijTP/source/packages/coding-agent`.
Agent-core tests and the declared full check ran from that same private pinned source's `packages/agent` directory and root respectively.
Workspace-local dependencies, including the pinned OpenAI SDK 7.19.0, were copied with the root dependencies; no dependency manifest or lockfile was changed.
The Pi build log is `/private/tmp/pi-input-baseline.49ijTP/pi-build.log`.

This is API and PTY proof, including core layout-state assertions; it does not claim native visual acceptance.
Main still owns installation, activation, final trust/reviews, and the full end-user Hunk/Herdr visual and key acceptance.
The original `handovers` server and processes, separate acceptance session, global configuration, native hook trust, durable slot lease, and other owners' files were preserved.
No repository staging, commit, activation, or original live process control was performed.
