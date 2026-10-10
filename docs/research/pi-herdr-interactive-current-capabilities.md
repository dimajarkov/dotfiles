# Native interactive Pi and Codex children in Herdr

Research date: 2026-10-10.
This is a capability assessment and proposed specification, with implementation and runtime validation deferred.
The requested behavior is native interactive Pi or Codex in child Herdr panes, automatic pane closure after completion, and retained granular activity and transcripts in the master's `/subagents` dashboard.
Automatic closure supersedes the historical retained-pane decision.
The other historical decisions are inputs for review, rather than requirements automatically carried into this proposal.

## Feasibility and evidence boundary

Native Pi is feasible through an interactive Pi process and a child-side extension that publishes structured events and accepts control messages.
Native Codex is feasible through a private app-server, with the native terminal interface and master controller connected to the same exact thread.
Herdr exposes pane creation, targeting, closure, focus, zoom, agent reporting, and terminal lifecycle events needed for this design.
These are substantial backend and lifecycle changes, rather than a replacement renderer for the existing takeover overlay.

The installed APIs support these routes, and the [historical research](pi-subagents-herdr-panes.md#proof-results) records earlier runtime demonstrations of both native interfaces.
Those demonstrations used older installations and retained panes.
They do not prove the requested automatic closure, current-version integration, durable recovery, policy enforcement, or admission of human-initiated turns.
No agents or models were launched, no panes were created or controlled, no E2E tests were run, and no configuration was changed during this investigation.
Herdr inspection was limited to static help, command-group discovery, and API schema after confirming `HERDR_ENV=1`.
No focused-session inventory or terminal transcript was inspected.

## Installed versions and authoritative locations

| Component | Observed installation | Authority |
| --- | --- | --- |
| Pi | `1.1.0`, through `~/.local/bin/pi` and a Home Manager Nix wrapper | Installed `pi --version`, wrapper, [Nix package](../../nix/packages/pi-coding-agent.nix), and installed source/docs |
| Pi source | `earendil-works/pi`, revision `abe508e1b89912adde45528136c3221eb69acdd7`, plus the native message-admission patch | [Package declaration](../../nix/packages/pi-coding-agent.nix:5), [patch](../../nix/patches/pi-native-message-admission.patch) |
| Pi runtime | Node `22.23.1` | Wrapper invokes `/nix/store/smz0kkakhq96h1ipimiab6cf1yw4nn7n-nodejs-22.23.1/bin/node` |
| Codex | `0.160.1`, npm-installed native macOS ARM64 binary | Direct `~/.npm-global/bin/codex --version`, [package metadata](/Users/dmitrijarkov/.npm-global/lib/node_modules/@openai/codex/package.json), [installed README](/Users/dmitrijarkov/.npm-global/lib/node_modules/@openai/codex/README.md) |
| Codex launcher | `/opt/homebrew/bin/codex` is a local credential wrapper delegating to `~/.npm-global/bin/codex` | [Wrapper](/opt/homebrew/bin/codex), including its direct `app-server` route |
| Herdr | `0.9.3`, Homebrew installation | `/opt/homebrew/Cellar/herdr/0.9.3/bin/herdr --version`, installed `.brew/herdr.rb`, and version-tagged upstream source |
| Herdr API | Protocol `22`, schema version `1` | Installed `herdr api schema --json` |
| Extension development types | Pi packages pinned to `0.85.0`; Effect `^4.0.0-beta.99` | [Extension package](../../home/.pi/agent/extensions/subagents/package.json) |

The deployed `~/.pi/agent/extensions/subagents` is Home Manager's out-of-store link to this repository's extension directory, as declared in [home.nix](../../home.nix:365).
This identifies the deployed files, but does not establish which revision an already-running Pi process has loaded.
The installed Pi source root used below is `/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent`.
All installed Pi links in this report refer to that immutable build, including its local patch.

The local Codex checkout at `/Users/dmitrijarkov/dev/tools/codex` is at `ebe75bb683b3c237aad9f039ab17b187048aa499`, dated 2026-05-09, with an existing modified `scripts/debug-codex.sh`.
It is not a source checkout matched to the installed `0.160.1` binary.
For example, its native remote parser documents fewer endpoint schemes than the installed CLI accepts.
Its app-server README can corroborate architecture, but cannot establish exact installed behavior.
The installed help and current [official app-server documentation](https://developers.openai.com/codex/app-server/) are the stronger Codex capability references.

## What the local extension does today

### Execution and control

The [backend interface](../../home/.pi/agent/extensions/subagents/src/backend.ts:33) presents metadata, a normalized event stream, `send`, and `interrupt` under an Effect scope.
Closing that scope owns interruption or termination of the underlying session.
There is no separate native-pane attachment or durable conversation owner.
The [runtime](../../home/.pi/agent/extensions/subagents/src/runtime.ts) wires real Pi, Codex, and compatibility Claude backends into one manager.

The [Pi adapter](../../home/.pi/agent/extensions/subagents/src/backends/pi.ts:282) creates an in-process SDK session, persists it through `SessionManager.create(cwd)`, loads normal global/package resources and trust-gated project resources, and binds extensions in `print` mode.
It subscribes to lifecycle, message, text/thinking delta, queue, tool execution, usage, and model metadata events.
It sends active-run input through `session.steer`, and starts a prompt when idle.
It already settles on `agent_settled`, which is the appropriate installed Pi boundary for this proposal.
Its metadata reports the session file, but does not currently include Pi's native session ID.

The [Codex adapter](../../home/.pi/agent/extensions/subagents/src/backends/codex.ts:320) starts a scoped, detached `codex app-server --stdio` process with pipe-based JSON-RPC.
It initializes the connection and creates a persistent thread with `approvalPolicy: "never"` and `sandbox: "danger-full-access"`.
It translates selected native messages into the same normalized stream.
Busy `send` requests are queued as later turns, rather than using native `turn/steer`.
Its declared steering capability is therefore false, despite the native protocol supporting steering.

The Codex notification handler [drops turn and item events when `activeRun` is false](../../home/.pi/agent/extensions/subagents/src/backends/codex.ts:582), and adopts only starts it expects from its own dispatch.
A human starting a turn through an attached native interface would require new adoption logic.
The handler also needs explicit thread-ID filtering before accepting metadata or turn events, especially when auxiliary threads exist.
Today, a `turn/completed` status other than `failed` or `interrupted` falls through to success.
The new adapter should recognize explicit terminal statuses and reject or preserve unknown statuses rather than auto-closing on that fallback.

The compatibility [Claude adapter](../../home/.pi/agent/extensions/subagents/src/backends/claude.ts:326) uses a scoped SDK query, bypass permissions, and excludes `Agent` and `Task`.
It is not a proposed native-pane backend here.
No work was routed through Claude or a Claude documentation adapter.

### Manager, activity, and UI

The [manager](../../home/.pi/agent/extensions/subagents/src/manager.ts:45) allows four running children across all backends and origins, with synchronous spawn reservations and restart admission.
It retains at most 64 tracked entries and closes backend scopes when pruning settled entries.
Normal settlement leaves a session available for continuation.
The status model has only `running`, `done`, and `error`; interruption becomes `error` with an abort message.

The [domain](../../home/.pi/agent/extensions/subagents/src/domain.ts:139) captures assistant text/thinking, user messages, tool starts/updates/results, queues, usage, metadata, and outcomes.
Events have no durable sequence, native turn ID, run ID, initiating actor, attachment identity, or pane generation.
The `turns` field counts finalized assistant messages, rather than native user turns or logical assigned runs.
The model omits newer Pi nested-tool parent IDs, blocking UI prompts, retry/compaction activity, and much native session navigation metadata.

The manager retains 512 transcript items and bounds each transcript text field to 64 Ki characters, streaming fields to 128 Ki characters, and final text to 1 Mi characters.
These are JavaScript string-length limits, not exact byte limits.
The [transcript renderer](../../home/.pi/agent/extensions/subagents/src/ui/transcript.ts) displays this normalized, bounded projection.
It is not a complete native transcript archive.
The [format helpers](../../home/.pi/agent/extensions/subagents/src/format.ts) render aggregate status and context occupancy without controlling the backend.

The master's [dashboard and takeover](../../home/.pi/agent/extensions/subagents/src/ui/takeover.ts) are Pi custom UI overlays.
Selecting a child opens the normalized transcript and a replacement input editor, rather than its native harness interface.
Sending and cancellation go through manager requests.
Escape returns through the dashboard, and another Escape closes it.
Keeping this dashboard as the master activity/history view is a useful seam, while active-child entry becomes a Herdr-pane action.

### Result delivery and disposal

Unconsumed normal results are [deferred until the master is idle](../../home/.pi/agent/extensions/subagents/index.ts:180), then delivered as follow-up custom messages with `triggerTurn: true`.
Explicit wait or cancellation can consume the corresponding automatic result.
Aborting a wait does not stop its children.
Tool result text is truncated separately from the retained session files.

The [deferred queue](../../home/.pi/agent/extensions/subagents/src/result-delivery.ts) is an in-memory map keyed only by child ID.
A later result from the same child can replace an earlier deferred result.
Draining clears the map before message delivery, and `pi.sendMessage` supplies no native admission receipt.
This does not provide durable replay or delivery guarantees after closing the pane or restarting the master.

Parent [session shutdown](../../home/.pi/agent/extensions/subagents/index.ts:250) clears the queue and disposes the runtime.
The manager's [finalizer](../../home/.pi/agent/extensions/subagents/src/manager.ts:657) closes all child scopes with bounded waits.
The present design cannot preserve children through parent reload or orderly exit, or reconstruct their dashboard entries afterward.
Abrupt parent loss is not a defined recoverable ownership protocol either.

The Pi adapter bounds abort and child shutdown handling, then disposes the session.
The manager can mark interruption before force-disposal has finished.
The [Codex interrupt path](../../home/.pi/agent/extensions/subagents/src/backends/codex.ts:947) sends `turn/interrupt` and returns before the terminal notification, with a 1.5-second fallback that settles locally and asynchronously terminates the process group.
Consequently, `RunSettled` alone does not always prove process quiescence in the current adapters.
Reusing it as an immediate pane-close trigger would race with shutdown, transcript persistence, and tools still executing.

### Documentation drift

The local [design plan](../../home/.pi/agent/extensions/subagents/docs/design-plan.md), [Effect guide](../../home/.pi/agent/extensions/subagents/docs/effect-v4-extension-guide.md), and [Effect notes](../../home/.pi/agent/extensions/subagents/docs/effect-v4-notes.md) describe the architecture and earlier stub stages.
Several comments still say the real backends are planned or stubbed, while the source now implements them.
Source is authoritative for current behavior.
The development Pi type pins are substantially older than the installed host and should be aligned before implementation validation.
The historical report's ignored-result-file problem is no longer current: both `src/result-delivery.ts` and `result-delivery.test.ts` are now tracked and the test is listed in the package's ordinary test script.
No tests, dependency installation, or type-generation commands were run for this research.

## Native Pi bridge capability

Installed [CLI documentation](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/docs/cli.md:30) selects native interactive mode when stdin and stdout are terminals.
`--mode rpc` selects a different, headless frontend and cannot itself provide the requested native TUI.
Likewise, opening the same session file in a second Pi process is a resume operation, not a live attachment to the first process.
The proposed child must own one real interactive Pi process and one session writer.

The installed [extension API](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/src/core/extensions/types.ts:931) exposes agent, message, tool, queue, model, UI-prompt, and settlement events.
`agent_settled` explicitly means no automatic retry, compaction, or queued continuation will run.
`agent_end` is an earlier agent-loop boundary and is insufficient for automatic closure on this installation.
`agent_before_settle` can request another continuation, which reinforces that distinction.
The child bridge should observe settlement after those handlers, freeze new admissions, and then confirm the final outcome and session persistence.

The installed [input event](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/src/core/extensions/types.ts:1143) identifies interactive, RPC, and extension input and allows handling or transformation.
This provides a plausible gate for human input and controller reinjection, but does not by itself gate every extension command or internal automatic continuation.
Commands can dispatch before the normal input path when prompt-template expansion is enabled.
Admission therefore needs a documented boundary for prompts, commands, and resumed activity, rather than relying solely on `agent_start` after work has begun.

The local [native admission patch](../../nix/patches/pi-native-message-admission.patch) adds synchronous `pi.enqueueMessage` with a queued receipt or synchronous rejection.
The [installed declaration](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/src/core/extensions/types.ts:1701) explicitly distinguishes queue admission from later consumption or completion.
This is useful for master result insertion and custom-message control, but is not automatically an acknowledged replacement for every user-message operation.
`pi.sendUserMessage` remains void-returning, and its internal asynchronous errors are routed to extension errors.
A bridge must distinguish received, admitted, observed in session, and completed states rather than acknowledge merely invoking that API.

Installed [extension lifecycle docs](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/docs/extensions.md) specify runtime replacement on reload and orderly shutdown through `ctx.shutdown()`.
Bridge resources should start at `session_start`, shut down idempotently, and reconnect with a new runtime generation after reload.
They should not start during extension-module loading, since help and resource discovery can load extensions.
Event publication needs bounded buffering or a durable spool so a disconnected or slow master cannot freeze the native interactive path.

Installed [session-format docs](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/docs/session-format.md) describe JSONL history, session IDs, branches, model changes, compaction, and custom entries.
That native history is the durable transcript authority, while the dashboard is an indexed projection with explicit truncation and a link to full history.
Pi branch or session switching must update the association, or be prohibited for managed children until the manager can follow it safely.

## Native Codex on the same live thread

Installed `~/.npm-global/bin/codex --help` and `resume --help` accept `--remote` with `ws://`, `wss://`, `unix://`, and `unix://PATH` endpoints.
Installed `app-server --help` accepts Unix listeners as well as stdio and WebSocket transports.
The native UI can therefore connect to a private Unix endpoint and resume a specified thread on that execution host.
Using a new local Codex process against the same rollout file would not establish this live shared-host property.
The proposed command shape is `codex app-server --listen unix://PATH` for the private host and `codex --remote unix://PATH resume THREAD_ID` for its native interface.
These are planning templates, not commands executed during this investigation.

The [official app-server documentation](https://developers.openai.com/codex/app-server/#connect-the-cli-terminal-ui) confirms remote native TUI connections.
Its [thread and turn protocol](https://developers.openai.com/codex/app-server/) supplies resume/read, paginated history, notifications, steering with an expected active turn ID, and interruption.
Each client needs its own initialized connection and thread subscription.
Unix remote endpoints use the WebSocket transport, so the current LF-delimited stdio parser is not the transport implementation for that connection.

The likely route is one private host per managed Codex child, one explicit native thread ID, and separate native-UI and controller connections.
The master should create or recover the thread, and the native interface should attach to that exact ID rather than a recent-thread picker.
The [older proof](pi-subagents-herdr-panes.md#codex-same-live-conversation-demonstrated) observed matching thread, active turn, session, and rollout identity, including native-interface input and programmatic control.
That proof also adopted an already-active turn through history pagination.
It remains historical evidence rather than a fresh `0.160.1` runtime verification.

The new adapter must accept target-thread turns initiated by the native interface, reconcile current state before consuming deltas, and deduplicate event/history overlap.
It must preserve the distinction between parent-queued follow-ups and live steering unless the user chooses to change current semantics.
It must also observe native settings changes, blocked requests, errors, background tool processes, and connection loss without confusing them with completion.

Disconnecting the native UI does not terminate the private server.
The [documented unsubscribe policy](https://developers.openai.com/codex/app-server/#unsubscribe-from-a-loaded-thread) allows a thread to remain loaded after its last subscriber leaves.
The documented experimental background-terminal list/clean methods may help cleanup, but their availability and behavior in this exact installation have not been exercised.
A close policy must therefore supervise the private execution host and its owned descendants separately from the UI pane.

The older proof observed an auxiliary ephemeral title-generation thread on `gpt-5.6-luna` while the assigned main thread used `gpt-6-luna`.
Disabling recursive model delegation does not necessarily disable that native title work.
Filter by exact assigned thread identity, account for auxiliary usage separately, and decide whether automatic naming should be suppressed if a supported installed setting exists.
The precise suppression setting and strict no-extra-model-call behavior remain unverified.

## Herdr closure and terminal facts

The [Herdr skill](/Users/dmitrijarkov/.agents/skills/herdr/SKILL.md) was read before CLI discovery, and its required context check passed with `HERDR_ENV=1`.
Installed group help and schema expose explicit pane IDs, terminal IDs, split direction, cwd/env, focus, zoom, move, close, agent session reports, and close/exit/focus events.
`agent start` waits for readiness rather than assigned-task completion.
Herdr's `done` means an idle agent not yet viewed, and `unknown` conveys no reliable lifecycle conclusion.
Neither is a result-completion protocol.

The version-matched [split source](https://github.com/herdrdev/herdr/blob/v0.9.3/src/workspace/tab.rs#L385) clears tab zoom when inserting a split, even when focus is not requested.
The design must explicitly choose queued creation while zoomed or temporary unzooming, rather than assume a no-focus split preserves the master view.
The historical queued-creation behavior is one option, not a binding decision.

The version-matched [close handler](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/api/panes.rs#L1948) can reject a pane close when it would implicitly close a protected worktree group.
The installed close schema takes a pane ID and provides no owner or generation compare-and-swap condition.
The [terminal runtime](https://github.com/herdrdev/herdr/blob/v0.9.3/src/terminal/runtime.rs#L19) delegates shutdown to the pane runtime.
The [pane-runtime cleanup](https://github.com/herdrdev/herdr/blob/v0.9.3/src/pane.rs#L1558) shuts down PTY IO and sends hangup, terminate, then kill to discovered processes in the owned terminal session, with short bounded grace periods.
Closing a pane is destructive to its terminal session, rather than merely hiding the native UI.
It is also not a proof that an independently detached app-server has stopped.

Pane IDs are opaque handles and can change when a pane moves across workspaces, while terminal identity remains distinct.
A controller must follow move/close events and revalidate its exact owned attachment before closing it.
A pane repurposed as an ordinary shell or another task must not be closed because an old child record still names it.
The absence of a conditional close operation leaves a race that needs explicit ownership and serialized attachment operations, or a documented limitation.
A protected-close rejection should leave a visible cleanup failure in the dashboard rather than bypass the guard.

Terminal screen reads and alternate-screen history cannot provide complete transcripts or authoritative outcomes.
Use structured bridge/protocol data for activity and native session history for recovery.
If custom Escape navigation is selected, a controlling PTY wrapper is needed to intercept keys while an external editor owns the terminal.
The historical wrapper demonstrated this with synthesized keys, but used a 40 ms legacy Escape/Alt heuristic and did not establish universal physical-keyboard behavior.
Ordinary native key handling avoids requiring that wrapper solely for navigation.

## What to take from HazAT's extension

The upstream reference inspected is pinned at [`c100577ebf7393a11d098ad9810ec6c269dcfc30`](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30).
Its [README](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md) describes native interactive children and configurable automatic exit, with several terminal backends but no Herdr adapter.
The local `/Users/dmitrijarkov/pi-interactive-subagents` checkout is an older, modified checkout and was not treated as clean upstream authority.

Its [child extension](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L16) auto-exits after a non-aborted agent end, including errors with explicit error reporting.
Human input does not disable automatic exit; abort leaves the child available for inspection or another prompt.
Its [watcher](https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1300) recovers the session result and closes the terminal surface after exit.
Its child activity recorder and parent watcher offer useful separation between native UI, structured progress, and surface cleanup.
Its `agent_end` exit hook must be adapted to installed Pi's later `agent_settled` boundary.
It is an architectural reference, not a drop-in implementation for this Pi fork, Codex backend, Herdr, or existing privacy/delivery rules.

## No-child-delegation, trust, and permission contract

The [current tool prompt](../../home/.pi/agent/extensions/subagents/src/prompt.ts:5) promises no nested agents/workflows or user questions, self-contained child context, and normal host permissions.
There is no current model-facing peer mailbox or child-send tool.
The [Pi adapter](../../home/.pi/agent/extensions/subagents/src/backends/pi.ts:41) excludes all five subagent tools plus exact names `workflow` and `ask_user`.
Installed Pi applies exclusion patterns to tool registration and later activation, making native `--exclude-tools` a viable starting point.
Exact exclusions do not automatically cover renamed tools, MCP question tools, extension commands, or direct shell launches.
In particular, a native child loading this extension can register `/btw`, which would permit another child through a command despite the model-tool denylist.
A managed-child mode must disable recursive command paths and audit the effective model tool set after resource loading and reload.
Broad host permissions mean this policy is harness orchestration control rather than an OS sandbox boundary.

Installed Codex `features list` reports `multi_agent` enabled and `multi_agent_v2` disabled.
The local [Codex config](/Users/dmitrijarkov/.codex/config.toml) also sets `max_threads = 6` and `max_depth = 2` for native agents.
The current adapter does not pass child developer instructions or feature overrides to disable that delegation surface.
Its generic rejection of unsupported server requests prevents headless answering, but does not remove a question tool from the model or prevent a native UI from answering it.
The installed `default_mode_request_user_input` feature is false, which does not prove that Plan-mode questions are absent.
Use child-specific feature overrides and explicit instructions in the proposed private host, then prove that recursive tools and forbidden question surfaces are actually unavailable.
The exact supported method for hard removal of all native question/Plan surfaces remains an implementation prerequisite.

Pi's [trust rules](../../home/.pi/agent/extensions/subagents/index.ts:124) inherit the live parent's decision for the same cwd, and consult persisted trust for an alternate cwd with failures treated as untrusted.
This gates project configuration/resources rather than rejecting every untrusted directory.
The proposed native Pi launch should inherit that resolved decision explicitly with `--approve` or `--no-approve`, retaining global resources without introducing a new trust prompt or silently broadening trust.
Installed [security docs](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/docs/security.md) distinguish project-resource trust from operating-system permissions and context-file discovery.
Moving from SDK print mode to native CLI can also add native builtin tools, so effective tool/resource parity must be audited rather than inferred from the same cwd.

The settled [capability policy](../agent-capability-policy.md) requires Codex children to retain `approvalPolicy: "never"` and `sandbox: "danger-full-access"`, including untrusted cwd selections.
The current Codex adapter follows that rule and does not consume Pi's project-trust flag as a sandbox setting.
The native connection must preserve the policy when resuming the thread or changing collaboration mode.
Unexpected approval, permission, MCP elicitation, or user-input requests need one explicit policy owner and a visible blocked/error outcome, rather than competing native and controller responses.
These capability settings do not authorize unrelated external actions.
This research and future planning prompts use plain prompts, with `/goal` reserved by policy for Codex feature implementation.

## Proposed integration seam and lifecycle

Keep the manager as the admission and dashboard authority, but separate durable conversation records, active runs, backend connections, and terminal attachments.
The current scoped backend interface can continue serving headless execution, while native execution needs attach/detach, quiescence, history recovery, and explicit owned-host termination operations.
Putting every native resource under the present parent-owned finalizer would silently retain today's kill-on-shutdown behavior.
Making all scopes immortal would instead remove cleanup ownership.
The selected parent-loss policy must determine which object owns the private host and its cleanup lease.

Use one Herdr adapter for exact targeting and reporting, one Pi child bridge, and one Codex private-host adapter.
The master dashboard continues to consume a shared normalized projection, with backend-native records retained for detail and recovery.
Each record should include parent session ID, child ID, origin, cwd/trust decision, native session/thread ID, session path, run/turn IDs, event sequence, process generation, and current terminal/pane attachment identity.
Credentials and endpoint secrets belong in owner-private runtime files, not argv, activity previews, or repository evidence.

| Phase | Required behavior |
| --- | --- |
| Reserve | Atomically reserve capacity before any child can start model/tool work |
| Start and attach | Establish exact native identity, policy, authenticated readiness, and owned Herdr attachment before exposing it as ready |
| Run | Publish granular events, record human/controller input provenance, and preserve native history |
| Settle | Observe the backend's final boundary and outcome, with no pending continuation or unresolved owned request |
| Freeze | Stop new input admission for this attachment so completion cannot race with a new human turn |
| Retain | Persist the run outcome, final/partial output, transcript cursor, identity, and delivery intent before closing |
| Stop | Gracefully shut down the native process and, if selected, its private host, with confirmed exit or explicit cleanup failure |
| Close | Revalidate exact attachment ownership, close only that pane, and record the close acknowledgement or guard rejection |
| Inspect or resume | Keep the dashboard row/history available and create a new native attachment only for an explicit admitted continuation |

Auto-close should follow a persisted logical-run outcome, not terminal idleness, a final-looking assistant message, a timeout, or a lost connection.
The default proposed behavior is closure after successful settlement, with failure and cancellation behavior selected explicitly below.
If a human continuation was already admitted before freeze, completion must cover that continuation or cancel the pending close under a defined policy.
An unsent native editor draft is not represented by ordinary model events, so preservation of drafts cannot be promised without a supported draft signal or a keep-open action.
The master's consumption of a result should not be required before closing, since the master may still be working.
Durable delivery intent and recoverable history are the closure prerequisites.

Result receipts should be keyed by child and run, preserving every completed continuation rather than replacing results by child ID.
Separate persisted outcome, pending delivery, native queue admission, explicit wait consumption, and observed parent-session insertion.
The patched `enqueueMessage` can confirm admission, while durable receipt reconciliation is still needed for crashes around insertion and receipt recording.
Do not claim exactly-once delivery merely because enqueue returned successfully.
A failed close must not erase or redeliver an already-recorded result.

The four-running-child limit should remain a single global admission authority if that existing policy is retained.
It must cover `/btw`, resumed runs, manual native turns, and controller sends, rather than just new panes.
Pi's input/bridge seam offers a candidate gate.
No current Codex child extension hook establishes a pre-start gate for native `turn/start` requests, so enforcement may require a protocol relay or a supported execution-host gate.
Limiting open panes to four is a different policy from limiting active runs to four and should not be silently substituted.

## Retention, resumption, and `/btw`

Automatic pane closure should retain the child conversation on disk and its dashboard identity, outcome, and transcript projection.
The present 64-entry pruning rule should become a display/cache policy rather than permission to kill or delete independently owned work.
Retention duration, archive limits, and transcript deletion should be explicit and independent of closing a terminal surface.
There is no requirement to leave the native process running indefinitely merely to retain its history.

For Pi, later resumption should open the retained native session after the previous writer has stopped.
For Codex, resumption should use the retained exact thread, either on a surviving private host or a replacement host loading that thread under the chosen ownership policy.
Never create a second concurrent Pi writer or accidentally fork a new Codex conversation while presenting it as the same child.
Resume creates a new run and pane generation, preserves origin, rechecks trust/policy, and reserves capacity.
Whether children survive master reload, exit, or crash remains a decision because the historical survival requirement is not binding for this request.

Current [`/btw`](../../home/.pi/agent/extensions/subagents/index.ts:670) creates a Pi child with its own context, cwd/trust/model inheritance, and the same global cap.
It opens takeover immediately and marks the child `origin: "btw"`.
The [model-visibility filter](../../home/.pi/agent/extensions/subagents/src/by-the-way.ts:18) hides those children from model-facing tools, including guessed IDs.
Its result is appended as a non-context `btw-result` custom entry and notified in the UI without waking the main model.
That custom entry survives in parent history, but the current manager does not reconstruct its child row on reload.

If `/btw` adopts native panes, preserve that privacy through history reconstruction, resume, event filtering, and result delivery.
Human continuation must not silently change a private aside into a model-visible child.
Alternatively, `/btw` can retain its current overlay path while normal delegated children gain native panes, but that mixed interaction needs an explicit product decision.
The managed Pi child must not itself expose `/btw` as recursive delegation.

## Remaining decisions for the next specification

Automatic pane closure and retained master activity/transcripts are the current requirements.
The following choices need to be settled before implementation, without requesting answers during this research pass.

| Decision | Proposed default | Consequence or unresolved detail |
| --- | --- | --- |
| Completion boundary | Close after the admitted logical run fully settles | Do not equate each assistant message or low-level agent loop with completion |
| Errors and cancellation | Retain full outcome and partial history, with explicit retry/resume | Choose automatic closure for these outcomes or a visible inspection pause; HazAT retains aborted children |
| Human input at completion | Admit input centrally; once closing starts, require resume | Decide whether a pending draft or active visit delays closure and how that is observable |
| History retention | Keep session/thread and dashboard association after pane close | Choose disk limits, archival, and deletion policy separately from the current 64-row cache |
| Parent reload, exit, and crash | Define separately from pane auto-close | Durable supervision is required if running children must survive; current finalizers terminate them |
| Concurrency | Preserve four active managed children, including private asides | Native Codex pre-start admission still needs a proven gate |
| `/btw` interaction | Apply the same native-pane lifecycle while preserving privacy | Keeping its existing overlay is a valid alternative requiring an explicit choice |
| Enter, focus, and zoom | Enter an active child from `/subagents`; completed rows open retained history | Choose tiled layout, focus-on-spawn, zoom, and behavior while the master is zoomed |
| Escape and external editors | Preserve native keys unless the old navigation contract is selected again | Master-return Escape plus Ctrl+] requires the controlling PTY wrapper and terminal validation |
| Codex continuation semantics | Preserve queued parent follow-ups; expose steering deliberately | Do not silently change busy-send behavior because native steering exists |
| Outside Herdr | Preserve the existing headless backend path | Inside-Herdr startup failure should be visible rather than an invisible fallback if native panes are required |
| Native session navigation | Initially keep the assigned conversation identity fixed | Supporting `/new`, branching, mode/policy changes, and Codex thread selection requires tracked identity transitions |
| Auxiliary Codex work | Record separately and investigate supported suppression | A no-child-delegation promise alone does not eliminate native title-generation calls |

## Unknowns and deferred acceptance evidence

The installed native attachment routes are available, but no fresh runtime proof has established them with Pi `1.1.0`, Codex `0.160.1`, and Herdr `0.9.3` together.
Auto-close after durable result capture, physical key behavior, partial startup cleanup, and exact exit acknowledgement are untested.
Reliable closure of moved or repurposed panes needs an ownership protocol despite Herdr's non-conditional close API.
Codex native pre-start admission and hard removal of question/delegation surfaces are the main unresolved policy seams.
Durable reconnect, sequence replay, crash recovery, parent result reconciliation, and child history reconstruction are absent from the current implementation.
Draft retention, Pi branch/session changes, Codex auxiliary work, and background-tool cleanup require explicit handling or documented unsupported behavior.

Future authorized validation should demonstrate matching native identities, master observation of human turns, both queue and steer semantics, four-child admission, policy preservation, `/btw` privacy, and failure/cancellation outcomes.
It should demonstrate that completion is persisted before pane closure, the native process and any owned host stop according to policy, and closed children remain inspectable and resumable without creating duplicate conversations.
It should also cover master reload/loss under the selected policy, moved panes, protected-close rejection, zoomed startup, late events, duplicate history replay, and a human input race during settlement.
These are requirements for a later implementation and proof task, not commands executed or authorization inferred by this report.
