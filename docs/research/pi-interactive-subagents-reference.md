# Interactive Pi children in Herdr: reference research and specification input

## Conclusion and evidence boundary

Use the reference's native Pi process, child-side lifecycle observation, explicit terminal targeting, and separation of pane lifetime from saved conversation history as inspiration.
Its implementation launches interactive Pi in a terminal surface, closes that surface after its watcher settles, and retains a session path in the result notification. [U-launch][U-watch][U-delivery]
It does not supply our requested durable, granular master `/subagents` archive, a Herdr adapter, or a reliable distinction between task completion and an ordinary interactive run ending. [U-mux-detection][U-running-state][U-child-end][U-widget]
The recommended upgrade is therefore a new interactive adapter behind our existing orchestration interface, with durable run receipts and history retention before automatic pane closure. [C-interface][C-events][C-delivery]

- Research date: 2026-10-10.
- Reference repository: `HazAT/pi-interactive-subagents`.
- Exact default-branch commit: [`c100577ebf7393a11d098ad9810ec6c269dcfc30`](https://github.com/HazAT/pi-interactive-subagents/commit/c100577ebf7393a11d098ad9810ec6c269dcfc30).
- Commit date: 2026-05-12, release version `3.7.2`. [U-package]
- Local checkout inspected: `/Users/dmitrijarkov/dotfiles`, branch `master`, HEAD `bb134f666f8a49e3d401b7117b76e033da7ec173`.
- Permanent local-source citation revision: [`bce6ddefc2118fc183064dd3d5cfd3dcd142d581`](https://github.com/dimajarkov/dotfiles/commit/bce6ddefc2118fc183064dd3d5cfd3dcd142d581).

The local HEAD was one commit ahead of `origin/master`, but the compared extension directory, capability-policy document, and historical research document had no diff against the public citation revision.
Local-source links below therefore identify the exact inspected file contents without linking to an unpublished HEAD.
GitHub reads used installed `gh-axi`, including default-branch commit resolution and fixed-commit tree/blob retrieval.
All 32 reference files were downloaded into a temporary root with mode `0700`, and each downloaded file's size and Git blob SHA-1 were verified against the fixed tree.
Upstream source, scripts, agent definitions, and repository skills were treated as untrusted inspection material.
No upstream scripts, imports, tests, dependency installation, native child processes, or multiplexer operations were executed.
This is static source research, not evidence that upstream tests pass or that the current installed Pi/Herdr combination supports this design.
The only requested repository output is this note.

### Evidence labels

- **Implemented**: executable behavior present at the cited revision, without a claim of runtime verification.
- **Claim or intent**: README, comments, agent instructions, or workflow prose describing expected behavior.
- **Inference**: a consequence derived from cited code paths, not a reproduced failure.
- **Gap**: a required capability absent from the inspected implementation or not demonstrated by its inspected tests.
- **Recommendation**: proposed behavior for our upgrade, not an upstream or deployed feature.

The historical [Herdr research note][H-scope] records a proposed design and earlier feasibility work.
It is historical evidence of decisions and reported experiments, not proof of today's extension or terminal behavior. [H-scope][H-proof]
The current request supersedes its retained-finished-pane rule with automatic pane closure after completion, while requiring granular activity and transcript retention in the master. [H-decisions]
All other historical choices below are carried forward as candidates for the new specification, not silently reconfirmed requirements. [H-decisions]

## Upstream architecture and launch transport

### Entry points and ownership

**Implemented:** `package.json` registers only `pi-extension/subagents/index.ts` as the package extension. [U-package]
That module owns agent discovery, launch preparation, running-child state, terminal operations, watcher startup, status supervision, tools, commands, and result renderers. [U-discovery][U-running-state][U-launch][U-delivery][U-commands]
The child command additionally loads `subagent-done.ts`, which subscribes to Pi events and registers `caller_ping` and `subagent_done`. [U-pi-command][U-child-events][U-child-tools]
The other production modules separate terminal operations (`cmux.ts`), session-file helpers (`session.ts`), activity recording (`activity.ts`), and coarse status classification (`status.ts`). [U-mux-detection][U-session-seed][U-activity-schema][U-status-classifier]
The reference's parent extension maintains an in-memory `runningSubagents` map rather than a durable manager registry. [U-running-state]

**Claim:** the README calls the tool immediate and fully non-blocking. [U-readme-flow]
**Implemented qualification:** launch performs synchronous multiplexer calls, creates a surface, and usually awaits a shell-ready delay before returning the acknowledgement. [U-surface-create][U-launch-session][U-send-script]
The long-running model work and completion watcher are asynchronous after launch, but pane creation and readiness are not instantaneous. [U-launch-session][U-delivery]

### Native child process

**Implemented:** Pi children run `pi --session <child-file> -e <subagent-done.ts>` with optional model, prompt, tools, and positional prompts. [U-pi-command][U-child-env][U-task-delivery]
There is no `--print` or RPC launch mode in that command, so the source launches the normal interactive CLI rather than a parent-rendered approximation. [U-pi-command]
The multiplexer supplies the terminal surface, and the child runs as a separate process invoked through that surface's shell. [U-send-command][U-send-script]
The launcher writes a Bash script and sends the short `bash <script-path>` command to avoid typing long commands directly into the terminal line. [U-send-script]
The generated command prints `__SUBAGENT_DONE_<exit-code>__` after Pi returns. [U-command-tail]
The implementation does not establish an acknowledged bidirectional Pi control channel, a native-process readiness handshake, or an owned process handle in the parent. [U-running-state][U-send-script][U-poll]

**Implemented:** task and identity files are stored below the parent's session artifact directory, while the native child JSONL is stored below the selected child agent directory's sessions tree. [U-artifact-path][U-launch-session][U-system-prompt][U-task-delivery]
`PI_SUBAGENT_ID`, `PI_SUBAGENT_SESSION`, `PI_SUBAGENT_ACTIVITY_FILE`, display identity, and surface identity are passed through environment variables. [U-child-env]
The configured shell-ready delay defaults to 500 ms and accepts a nonnegative parsed integer from `PI_SUBAGENT_SHELL_READY_DELAY_MS`. [U-ready-delay]
**Inference:** an elapsed delay cannot prove that the expected Pi process is ready or that the shell accepted the command. [U-ready-delay][U-send-command]
**Gap:** failures after surface creation but before registration have no enclosing launch rollback that closes the newly created surface. [U-launch-session][U-pi-command][U-command-tail]

### Terminal backends

**Implemented:** backend selection accepts `PI_SUBAGENT_MUX`, otherwise tries cmux, tmux, Zellij, then WezTerm using environment markers and executable availability. [U-mux-detection]
Herdr is absent from the backend union and selection paths. [U-mux-detection]
Forced selection of an unavailable supported backend returns no backend rather than selecting another one. [U-mux-detection]

| Backend | Implemented placement and targeting | Qualification |
| --- | --- | --- |
| cmux | First child creates a right split; later children add surfaces/tabs to the remembered child pane. [U-surface-create] | Captures focused/caller identities, restores focus conditionally after creation, and checks remembered pane existence using tree text. [U-cmux-focus][U-surface-create] |
| tmux | Splits from `TMUX_PANE`, uses detached `split-window -d`, and targets returned `%pane` IDs for input, capture, and closure. [U-surface-create][U-surface-split][U-send-command][U-screen][U-close] | It repeatedly splits rather than allocating our historical lower child region. [U-surface-create] |
| Zellij | Inspects tab geometry, splits only when every candidate remains usable, otherwise stacks on a non-parent pane or creates a new tab. [U-zellij-layout][U-zellij-create] | Uses a temporary session-scoped lock and explicit `--pane-id` for the listed pane operations. [U-zellij-lock][U-zellij-target] |
| WezTerm | Uses `cli split-pane`, numeric pane IDs, `send-text --no-paste`, `get-text`, and `kill-pane`. [U-surface-split][U-send-command][U-screen][U-close] | The default create path supplies no explicit parent pane to the split, and its live integration enumeration excludes WezTerm. [U-surface-create][U-integration-backends] |

Zellij's default readable minimum is 50 columns by 10 rows, configurable with `PI_SUBAGENT_ZELLIJ_MIN_COLUMNS` and `PI_SUBAGENT_ZELLIJ_MIN_ROWS`. [U-zellij-minimum][U-zellij-create]
Its lock waits up to ten seconds and treats a lock older than 30 seconds as stale without verifying the recorded owner's liveness. [U-zellij-lock]
**Inference:** age alone is insufficient ownership evidence for deleting a lock, especially during a slow operation. [U-zellij-lock]
cmux's conditional focus restoration is useful inspiration because it distinguishes the caller from the currently focused surface instead of always returning focus to the launching process. [U-cmux-focus]
**Gap:** none of these adapters implements our historical managed visit, zoom restoration, original-master return key, or external-editor Escape policy. [U-send-escape][U-surface-create][H-decisions]
The reference exposes Escape injection as an interrupt operation rather than reserving Escape for master navigation. [U-interrupt][U-send-escape]

## Session identity, context, and settings

### Identity and conversation modes

**Implemented:** each launch gets an eight-character `Math.random()`-derived running ID, a generated session filename, a terminal surface handle, and an activity file keyed by running ID. [U-launch][U-launch-session][U-activity-path]
Seeded conversations have a separately generated native session UUID and a `parentSession` file-path link. [U-session-seed]
These identifiers are not unified into a stable parent-child-task-run-generation record. [U-running-state][U-session-seed]
The child activity validator checks schema version and the expected running-child ID, but it does not validate parent session identity, current native session identity, or process/pane generation. [U-activity-validation]

The available modes are `standalone`, `lineage-only`, and `fork`, with agent defaults overridden by explicit `fork: true`. [U-session-mode]
`standalone` uses a fresh file without pre-seeding a parent link, while `lineage-only` writes a fresh linked header without copied turns. [U-session-mode][U-session-seed]
`fork` copies raw parent JSONL lines before the last user entry, removes session headers, and adds a fresh child header with lineage. [U-session-seed]
**Qualification:** the README's full-context wording does not mean the triggering user message or its subsequent entries are copied. [U-readme-modes][U-session-seed]
The unit fixture explicitly expects those messages to be absent. [U-test-seed]
**Inference:** raw line-prefix copying is not an explicit active-branch export, so a parent JSONL containing branches needs a separate correctness test. [U-session-seed]
Although session helpers implement branch-summary append and entry merge, the parent entry point imports only result extraction, new-entry reading, and session seeding. [U-session-helpers][U-entry-imports]
Consequently, the normal result flow is a parent notification rather than merging the child transcript into the parent's native conversation. [U-delivery]

### Agent definitions and discovery

**Implemented:** definitions are Markdown files with a small regex-based frontmatter parser. [U-frontmatter]
The parser supports model, tools, skills or singular `skill`, thinking, `deny-tools`, `spawning`, `auto-exit`, `interactive`, `system-prompt`, session mode, cwd, CLI, and discovery visibility. [U-frontmatter]
It does not implement a general YAML parser, and ordinary optional booleans are recognized through literal `true` comparison. [U-frontmatter]
Discovery overwrites bundled definitions with global definitions and then project-local definitions of the same declared name. [U-discovery]
Direct loading instead searches files named after the requested agent, in project, global, then bundled directories. [U-agent-load]
**Inference:** a definition whose declared name differs from its filename can be listed by one name but fail direct loading under that name. [U-discovery][U-agent-load]
`disable-model-invocation` filters listings after precedence resolution but does not forbid direct invocation of a hidden agent. [U-list][U-agent-load][U-test-hidden]
It is therefore a discovery setting, not a permission boundary. [U-list][U-test-hidden]

### Cwd, model, skills, and prompt inheritance

**Implemented:** the launch model is an explicit tool override or agent-definition default, and thinking comes only from the agent definition. [U-launch]
The Pi model argument includes the thinking suffix only when an effective model exists. [U-pi-command]
The launcher does not read the parent's active model or thinking level for a fresh child. [U-launch]
**Inference:** absent explicit defaults, a fresh child relies on its CLI settings rather than guaranteed inheritance of the parent's current UI selection. [U-launch][U-pi-command]
Forked session entries may carry model/thinking history, which is a separate mechanism from explicit launch-time inheritance. [U-session-seed]

Explicit relative `cwd` is based on `process.cwd()`, but a relative cwd from agent frontmatter is based on the global agent configuration directory. [U-cwd]
This contradicts the README table's description of agent cwd as relative to project root. [U-readme-frontmatter][U-cwd]
If the child cwd contains `.pi/agent/`, that directory becomes `PI_CODING_AGENT_DIR`; otherwise the current configured/global agent directory is used. [U-cwd][U-child-env]
This changes the child's configuration and session-storage root, not merely its working directory. [U-cwd][U-launch-session][U-child-env]
The reference itself adds no explicit trust-store lookup or parent trust decision to that launch. [U-cwd][U-pi-command][U-child-env]
This does not establish how the external Pi runtime would apply its own trust rules. [U-pi-command]

Skills are passed as separate `/skill:<name>` positional prompts. [U-skill-args]
Artifact-backed launches add an empty first positional prompt to preserve later skill-command expansion. [U-skill-args]
**Claim:** the comments explain this as a workaround for Pi's initial `@file` concatenation behavior. [U-skill-args]
**Gap:** argument-shape unit tests do not demonstrate the lifecycle of multiple skill prompts followed by an auto-exit task on our target Pi version. [U-test-skills][U-child-end]

For Pi, the agent body takes precedence over the tool's `systemPrompt` parameter. [U-task-wrapper]
Without `system-prompt: append|replace`, identity is inserted into the task wrapper as user-message text. [U-task-wrapper]
With that mode, the identity is written to a file and passed through `--append-system-prompt` or `--system-prompt`. [U-system-prompt]
Fork mode passes only the task as its direct prompt, so the wrapper's role and completion instructions are omitted unless identity is routed through a system-prompt flag. [U-task-wrapper][U-task-delivery]
**Qualification:** the tool schema describes `systemPrompt` as appended instructions, but the actual routing depends on agent frontmatter and may ignore the parameter when an agent body exists. [U-params][U-task-wrapper][U-system-prompt]

### Configuration surface

**Implemented:** status configuration is read at module load from package-root `config.json`, falling back to `config.json.example` only when the local file is absent. [U-status-config][U-artifact-path]
The status object accepts only Boolean `enabled`, with a fixed four-line notification limit and fixed 60-second snapshot-problem threshold. [U-status-config][U-status-constants]
Malformed local configuration fails rather than silently falling back. [U-status-config][U-test-config]
`status.enabled: false` disables the periodic status supervisor while the running widget and completion watcher remain separate mechanisms. [U-status-refresh][U-widget][U-delivery]
The code also provides explicit opt-ins for renaming tmux windows and sessions, while avoiding Zellij session rename. [U-titles]
These settings should not be confused with our desired Herdr layout, takeover, retention, or completion policy. [U-status-config][U-titles][H-decisions]

## Completion, interruption, and cleanup

### Task completion versus Pi events

**Implemented:** `turn_start` and `turn_end` update activity state, while `agent_end` controls auto-exit. [U-child-events][U-child-end]
The recorder can finish a turn while leaving the broader agent active, so those events represent different lifecycle levels in the implementation. [U-activity-transitions]
Without auto-exit, `agent_end` leaves the child in `waiting`; it does not send a completed result to the parent until the session later exits or explicitly signals completion. [U-child-end][U-poll][U-watch]
With auto-exit, the latest assistant stop reason determines whether `agent_end` shuts down the child. [U-child-end][U-child-exit-predicate]
Normal completion and provider/agent errors exit, while an aborted assistant response leaves the interactive session open. [U-child-exit-predicate][U-child-end]
The predicate returns true even when no assistant message is available. [U-child-exit-predicate]
There is no semantic task-completion validator, stable run receipt, or queued-work drain check in this auto-exit path. [U-child-exit-predicate][U-child-end]

**Implemented:** `subagent_done` writes a `done` sidecar and requests shutdown, with the previous assistant message used as the summary. [U-child-tools][U-watch]
`caller_ping` writes a `ping` sidecar and requests shutdown so the parent can later resume the saved conversation with guidance. [U-child-tools][U-delivery]
`caller_ping` checks that the child session environment variable exists, whereas `subagent_done` still requests shutdown when that variable is absent. [U-child-tools]
Provider failures under auto-exit write an explicit error sidecar rather than relying on a zero process exit code. [U-child-end]
This is a useful pattern for separating harness-level outcome from OS process status. [U-child-end][U-exit-decode]

### Watcher and automatic pane closure

**Implemented:** the watcher polls once per second, checking the session `.exit` file, optional Claude sentinel, then the last five terminal lines for the shell sentinel. [U-watch][U-poll]
The sidecar is deleted before its decoded result is returned to the caller. [U-poll]
Any parsed sidecar other than `ping` or `error`, including an unknown object or `null`, is treated as successful `done`. [U-exit-decode][U-test-exit-decode]
For normal Pi auto-exit, only errors get a sidecar in `agent_end`; success relies on shutdown followed by the shell sentinel. [U-child-end][U-command-tail][U-poll]

The watcher reads the session file, extracts the last usable assistant text, closes the terminal surface, removes the running entry, and only then returns the result for delivery. [U-watch][U-delivery]
Saved Pi history, task files, launch scripts, and activity snapshots are not removed by that successful Pi cleanup path. [U-watch][U-task-delivery][U-command-tail]
The parent retains the summary and saved session path in its completion message, but the running widget no longer contains the completed child. [U-widget][U-watch][U-delivery]
**Gap:** there is no archived-child dashboard entry or granular parent transcript browser. [U-running-state][U-widget][U-commands][U-result-renderer]
The retained native file is valuable, but it is not equivalent to a retained master `/subagents` view. [U-watch][U-result-renderer][C-dashboard]

**Inference:** observing a sidecar before shutdown has fully completed can cause surface closure while the child is still finishing its tool or session teardown. [U-child-tools][U-poll][U-watch]
There is no transcript flush acknowledgement or durable parent result receipt before closure. [U-watch][U-delivery]
**Inference:** a crash between deleting the sidecar, closing the pane, and delivering the parent message can lose the orchestration receipt even if native session history remains. [U-poll][U-watch][U-delivery]

### Failure and disconnect behavior

**Implemented:** watcher exceptions attempt to close the surface and remove the running entry. [U-watch-error]
If reading the screen fails and no sidecar appears, `pollForExit` catches the failure and continues polling without a missing-pane terminal outcome or overall timeout. [U-poll]
**Inference:** manual pane destruction without a sidecar can leave the watcher pending indefinitely. [U-poll]
Launch readiness, completion polling, and several CLI operations have no shared bounded supervision contract. [U-ready-delay][U-send-command][U-poll]

The parent shutdown handler clears timers, aborts module/watch controllers, and clears its running map. [U-parent-shutdown]
Module reload aborts the previous import's poll loops using global symbols. [U-reload]
Those aborted watcher paths attempt surface closure rather than preserving an independent managed child host. [U-watch-error]
**Qualification:** the comment about surviving reload refers to clearing old timers and loops, not durable child reconstruction or reattachment. [U-reload][U-parent-shutdown][U-watch-error]
No controller lease, persisted attachment record, receipt replay, or reconnect algorithm is present in these paths. [U-running-state][U-reload][U-parent-shutdown]
**Inference:** parent hard-crash behavior may leave a pane process alive without any recoverable parent watcher, because terminal execution and the parent's in-memory controller have separate lifetimes. [U-send-script][U-running-state][U-parent-shutdown]
The child recorder distinguishes quit from reload, new, resume, and fork shutdown reasons, disabling recording on the latter paths rather than reporting final done. [U-activity-transitions]
Its completion tools nevertheless address the fixed environment-provided session path, not a newly queried native session identity. [U-child-tools]
**Gap:** native session replacement or branching has no explicit parent adoption/rebinding protocol in this package. [U-child-env][U-child-events][U-child-tools]
**Inference:** switching conversations inside the native child can break the correspondence between visible work and the original saved-path result extraction. [U-child-tools][U-watch]

### Interruption and user takeover

**Implemented:** `subagent_interrupt` resolves a running child by exact ID or unambiguous exact display name and rejects Claude-backed interruption. [U-interrupt]
It sends Escape through the multiplexer and returns a local `interrupt_requested` acknowledgement. [U-interrupt][U-send-escape]
It immediately forces the local widget to `waiting` and ignores pre-interrupt snapshots until a newer observation arrives. [U-interrupt][U-status-interrupt]
It does not receive a child acknowledgement proving that the run or its tools stopped. [U-interrupt]
**Inference:** Escape could reach an editor or dialog instead of interrupting Pi if the pane's foreground application changed. [U-send-escape]
Do not release running capacity or report cancellation complete solely because terminal input was sent. [U-interrupt][C-manager-capacity]

**Claim:** README auto-exit documentation says later user input permanently disables auto-exit. [U-readme-auto-exit]
**Implemented contradiction:** `shouldAutoExitOnAgentEnd` ignores its `_userTookOver` argument, and the child resets the takeover marker after a non-exiting agent end. [U-child-exit-predicate][U-child-end]
A unit test explicitly expects normal completion to auto-exit even after the user supplied the prompt. [U-test-auto-exit]
The `interactive` option controls stall/recovery notifications, not whether the child has a native interface or whether its pane stays open after normal auto-exit. [U-interactive][U-status-refresh][U-child-end]
**Inference:** visiting or steering an auto-exit child does not provide a reliable keep-open lease. [U-child-exit-predicate][U-child-end]
The new specification must define user intervention and closure behavior directly rather than copying the README's takeover story. [U-readme-auto-exit][U-test-auto-exit]

## Activity, transcript, and result delivery

### What the upstream activity stream actually retains

**Implemented:** the child records phase, timestamps, sequence, latest event, active scope, turn index, current tool ID/name, and tool start/end times in one versioned JSON snapshot. [U-activity-schema]
Snapshot writes use a temporary file followed by rename, with streamed updates throttled to 500 ms. [U-activity-write][U-activity-recorder]
After three consecutive write failures the recorder silently disables itself. [U-activity-recorder]
The child subscribes to input, agent/turn lifecycle, provider requests, streaming event types, tool execution, completion, and shutdown. [U-child-events]
These callbacks update the current state rather than append an activity history. [U-activity-recorder][U-activity-transitions]
The snapshot contains no assistant text deltas, thinking text, tool arguments, tool output, full provider responses, token usage, or source-of-input attribution. [U-activity-schema][U-child-events]
Its single current-tool fields also do not model a set of concurrent tool executions. [U-activity-schema][U-activity-transitions]

The parent reads and validates that snapshot, renders a coarse running widget, and only wakes its model for stalled/recovered transitions of non-interactive children. [U-observe][U-widget][U-status-refresh]
Results, pings, and status notices use `pi.sendMessage` with `deliverAs: "steer"` and `triggerTurn: true`. [U-delivery][U-status-refresh][U-resume-delivery]
There is no explicit wait-consumption contract or durable delivery deduplication in this flow. [U-delivery][U-running-state]
The result renderer expands a summary and native session path, not a tool-by-tool child transcript. [U-result-renderer]

### Watchdog limits

**Implemented:** missing, invalid, wrong-ID, or never-ready snapshots can become stalled after the fixed problem threshold. [U-status-classifier][U-status-constants]
A readable valid `active` or `waiting` snapshot is classified healthy without expiring its last update time. [U-status-classifier]
The unit tests explicitly preserve those states several minutes after their timestamps. [U-test-status]
**Inference:** a frozen child leaving a valid active snapshot can appear active indefinitely, so this is snapshot-validity supervision rather than a heartbeat/liveness guarantee. [U-status-classifier][U-test-status]
Likewise, a recorder disabled after write failures can leave an old valid snapshot looking healthy. [U-activity-recorder][U-status-classifier]
A separate heartbeat can prove the bridge is responsive without mistaking a legitimately long tool call or quiet human session for failure. [U-test-status][U-live-long-tool]

### Summary extraction limits

**Implemented:** result extraction scans raw JSONL entries backward for usable assistant text and falls back to a provider error message when the latest error has no text. [U-session-result]
It deliberately excludes thinking blocks and tool results from the summary. [U-session-result][U-test-result]
**Inference:** it can return earlier text when the latest assistant message has no usable text and no recognized error, and it does not select an explicit native branch or correlated task run. [U-session-result]
The ordinary spawn watcher scans the entire child file, while resume additionally limits extraction to entries after the recorded pre-resume count. [U-watch][U-resume-delivery]
For forked history, relying on the whole file creates a potential stale-parent-answer fallback if the child produces no new usable answer. [U-session-seed][U-watch][U-session-result]
Our upgrade should preserve a run-specific terminal outcome even when no summary exists. [C-outcomes][U-session-result]

## Tools, workflows, resumption, and restrictions

### Functionality inventory

| Surface | Implemented behavior | Important distinction |
| --- | --- | --- |
| `subagent` | Launches a native child and starts a background watcher; returns ID/session/script metadata. [U-delivery] | No blocking wait, master send, explicit terminate tool, or running-child archive. [U-delivery][U-running-state] |
| `subagent_interrupt` | Requests turn interruption through Escape. [U-interrupt] | Local acknowledgement, not proven stopped work. [U-interrupt] |
| `subagents_list` | Lists visible agent definitions. [U-list] | It does not list running or finished child sessions. [U-list] |
| `subagent_resume` | Opens saved Pi history in a new surface, optionally sends a follow-up, and defaults to auto-exit. [U-resume-start][U-resume-env][U-resume-delivery] | It is process relaunch, not attachment to an already-running child. [U-resume-start] |
| `caller_ping` | Child writes a help receipt and exits. [U-child-tools] | The caller must later resume; no live question-response channel. [U-child-tools][U-resume-start] |
| `subagent_done` | Child explicitly signals done and requests shutdown. [U-child-tools] | Summary comes from earlier assistant text. [U-child-tools][U-watch] |
| `/subagent` | Resolves a named definition and injects a user message asking the parent model to call the tool. [U-commands] | It does not directly launch the process from the command handler. [U-commands] |
| `/iterate` | Injects a parent request for a full-context fork. [U-commands] | Workflow prompt, not a dedicated native takeover protocol. [U-commands] |
| `/plan` | Renames presentation where supported and injects bundled planning-skill text. [U-plan-command] | The staged orchestration is agent instructions, not an executable phase machine. [U-plan-skill][U-plan-command] |
| Child tools widget | Lists tool names and denied names, toggled with Ctrl+J. [U-child-widget] | Presentation does not itself enforce permissions. [U-child-widget][U-registration-deny] |

The README's extension inventory says one child-only tool, but the child entry point registers both `caller_ping` and `subagent_done`. [U-readme-tools][U-child-tools]
The bundled planner allows nested scouting by default, while scout, worker, and reviewer definitions set `spawning: false` and auto-exit. [U-planner-agent][U-scout-agent][U-worker-agent][U-reviewer-agent]
Those bundled Anthropic defaults are upstream choices, not suitable inherited defaults for our Codex-only Pi routing. [U-planner-agent][U-scout-agent][C-policy]

### Resume fidelity

**Implemented:** resume checks file existence, counts existing entries, creates a new pane, loads the completion extension, and optionally writes a follow-up artifact. [U-resume-start][U-resume-env]
It assigns a fresh running ID while reusing the saved native session path. [U-resume-start][U-resume-env]
The resume launch does not reconstruct the original cwd, agent identity, tools allowlist, deny list, skills, system-prompt mode, or explicit thinking/model launch arguments. [U-resume-start][U-resume-env]
Existing native session history may retain some runtime settings, but that is not evidence of full launch-policy restoration. [U-resume-start][U-session-seed]
The path-existence check does not validate parent ownership, an inactive writer, session schema, or an association record. [U-resume-start]
**Inference:** calling resume twice, or resuming a live file, can start multiple writers because no ownership lock is acquired. [U-resume-start][U-resume-env]
A leftover `.exit` file is not cleared or generation-checked before resume starts, so a stale sidecar can be consumed by the new watcher. [U-resume-start][U-resume-env][U-poll]
The `autoExit: false` override changes explicit launch environment construction but does not restore an original role policy. [U-resume-env]

### Permissions and delegation

**Implemented:** `spawning: false` expands to four reference lifecycle tool names, and `deny-tools` adds names to a deny set. [U-deny]
The parent extension reads `PI_DENY_TOOLS` and declines to register its own tools with matching names. [U-registration-deny]
The child tools widget displays that deny set, but the child `tool_call` handler only records activity. [U-child-widget][U-child-events]
**Gap:** this package does not globally reject arbitrary other-extension tools named by `deny-tools`, nor establish a sandbox, authenticated delegation boundary, or universal ban on child questions. [U-registration-deny][U-child-events][U-pi-command]
If explicit tools are requested, the launcher adds both child control tools to the CLI allowlist. [U-tool-allowlist]
Thus a control tool omitted from the requested list can still be enabled. [U-tool-allowlist]
The same-role self-spawn check only blocks an explicit requested role matching `PI_SUBAGENT_AGENT`; it is not a general no-nesting rule. [U-spawn-validation]
Human slash commands remain registered independently of the tool deny checks. [U-registration-deny][U-commands][U-plan-command]

**Implemented compatibility path:** `cli: claude` launches Claude Code with `--dangerously-skip-permissions`, optional plugin, optional model/prompt, and optional Claude session resume. [U-claude-launch]
Its stop hook counts string-valued user messages, writes a completion sentinel only when the count is one, and writes the transcript path for copying. [U-claude-hook]
This path does not translate the agent's Pi deny set or tools allowlist into native Claude restrictions. [U-claude-launch]
It should not be adopted for this upgrade because our current policy keeps Claude compatibility-only and this research requests native Pi children. [C-policy]
No Claude harness, plugin, script, or adapter was used to perform this research.

## Tests and limitations of the evidence

**Implemented tests:** the default unit command runs `test/test.ts`, covering session helpers, status configuration/classification, definition discovery, control-tool inclusion, auto-exit predicates, sidecar decoding, activity schema, interruption helpers, narrow rendering, and layout calculations. [U-package][U-test-seed][U-test-config][U-test-skills][U-test-auto-exit][U-test-exit-decode][U-test-activity][U-test-interrupt][U-test-layout]
Mocks record registrations and messages, but their `on()` method does not execute Pi lifecycle hooks. [U-test-mock]
These helper tests are not complete live-process lifecycle proof. [U-test-mock][U-test-auto-exit]
The separate `system-prompt-mode.test.ts` reproduces parsing/routing logic locally and is omitted from the default unit command. [U-package][U-test-system-prompt]
Its “end-to-end” portion reads temporary agent files through that copied parser rather than launching Pi. [U-test-system-prompt]

Live integration tests spawn real Pi/model sessions, test terminal command delivery and Escape bytes, and cover basic spawn, a long tool call, parallel work, fork linkage, help requests, discovery, and a system-prompt scenario. [U-integration-start][U-live-escape][U-live-basic][U-live-long-tool][U-live-fork][U-live-other]
The harness enumerates cmux, tmux, and Zellij, while its focus helpers support only cmux and tmux. [U-integration-backends][U-integration-focus]
**Inference:** when Zellij is available, the unconditionally included focus-preservation test can encounter unsupported helper paths. [U-live-focus][U-integration-focus]
WezTerm is absent from the harness's backend enumeration. [U-integration-backends]
When no backend is available, the test files log a skip notice and register no backend suites. [U-live-basic][U-live-focus]
Several lifecycle checks accept broad screen matches, and basic/fork session assertions execute only if a session-path regex matches. [U-live-basic][U-live-fork]
The system-prompt scenario verifies a marker file rather than asserting the requested custom response prefix. [U-live-other]
These are weaker guarantees than an acknowledged completion receipt, verified child pane removal, and a retained detailed transcript. [U-live-basic][U-live-fork][U-live-other]

**Gap:** the inspected tests do not demonstrate Herdr navigation, durable same-parent reconnect, archive-before-close, crash-safe result replay, full resume-policy restoration, live-writer exclusion, human-input origin correlation, or four-child admission. [U-package][U-integration-backends][U-test-mock][U-live-basic][U-live-other]
No test in this research was run, so pass counts and compatibility are intentionally unclaimed.
The upstream development dependencies use `@mariozechner/pi-*` around `0.65.0`, while our extension's development packages use `@earendil-works/pi-*` pinned to `0.85.0`. [U-package][C-package]
Neither package manifest proves compatibility with the installed target runtime, so event and shutdown semantics require fresh validation during a later authorized proof. [U-package][C-package]

## Comparison with our current extension

| Area | Current local implementation | Upgrade implication |
| --- | --- | --- |
| Pi execution | In-process SDK session with normal resource loading, explicit model resolution, excluded tools, and extensions bound in print mode. [C-pi-resources][C-pi-create] | Replace the execution adapter in Herdr with one native interactive Pi host, preserving those policies. [C-interface][C-pi-create] |
| Other harnesses | Codex uses a scoped stdio app-server; Claude retains an SDK compatibility path. [C-codex][C-claude] | Keep the seam and avoid adding the reference's Claude plugin or silently broadening this Pi feature. [C-interface][C-policy] |
| Master API | `subagent_spawn`, wait, cancel, check, and list; `/subagents` opens the dashboard. [C-tools][C-wait][C-other-tools][C-dashboard] | Preserve coordinated tools and consumption behavior even though upstream uses a smaller fire-and-forget API. [C-wait][U-delivery] |
| Human interaction | Overlay transcript plus input to steer or continue; leaving the child overlay returns to the dashboard. [C-takeover][C-takeover-input] | Native pane visits need a separate navigation/lifetime contract. [C-takeover][H-decisions] |
| Activity fidelity | Typed message/thinking deltas, finalized messages, tool lifecycle/previews, queued messages, usage, metadata, and terminal outcomes. [C-events][C-pi-events] | Keep and extend the normalized stream instead of replacing it with one coarse snapshot. [C-events][U-activity-schema] |
| Current retention | In-memory snapshots capped at 512 transcript items, bounded text, and 64 tracked entries; pruning closes settled scopes. [C-manager-limits][C-manager-prune] | A bounded UI projection must not be the durable archive or its pruning policy. [C-manager-limits][C-manager-prune] |
| Capacity | Four running children across backends; spawn reservations and idle restarts count against the limit. [C-manager-limits][C-manager-capacity][C-manager-restart] | Enforce the same limit before native composer starts and disconnected-host continuations. [C-manager-capacity][C-manager-restart] |
| Results | Idle-deferred follow-up delivery; explicit waits can consume pending automatic results. [C-delivery][C-wait] | Keep this coordination policy unless the user separately chooses upstream's immediate steering. [C-delivery][U-delivery] |
| Parent lifetime | Shutdown disposes the runtime and closes child scopes. [C-shutdown][C-manager-dispose] | Surviving reload/exit needs independent host ownership and reattachment, as a new feature. [C-interface][H-decisions] |
| Trust and defaults | Same-cwd trust inherits the parent decision; alternate cwd checks the persisted trust store; Pi inherits model/thinking explicitly. [C-trust][C-tools][C-pi-model] | Native interactivity must retain these checks, not inherit upstream's implicit CLI configuration behavior. [C-trust][U-cwd] |
| Child restrictions | Pi excludes orchestration tools, workflow, and `ask_user`; Codex explicitly uses never-approval/full-access settings. [C-pi-exclusions][C-codex-permissions] | Revalidate and enforce native child restrictions on every launch and resume. [C-pi-exclusions][C-policy] |
| User-only aside | `/btw` uses non-model-visible origin, and results are appended as entries without waking the parent model. [C-btw][C-delivery] | Keep transcript archives and automatic closures compatible with that privacy boundary. [C-btw][C-delivery] |

Our normalized run events have no stable run ID, and `turns` counts finalized assistant messages rather than independently identified management runs. [C-events][C-manager-fold]
The current deferred-result map is keyed by child ID, so another completion before flush replaces that child's earlier deferred result. [C-delivery-map]
That must change if every human or controller-origin continuation is to retain an independently deliverable result. [C-delivery-map][H-decisions]
The current transcript rendering shows tool-output previews rather than complete raw output, so “granular retained history” needs an explicit fidelity contract. [C-transcript][C-events]
Our Codex adapter discards run-related notifications when it does not believe a local run is active, which prevents treating native-user-started turns as automatically supported today. [C-codex-filter]
The historical note records a Codex attachment proof, but its reported findings are not a current native adapter implementation. [H-proof][C-codex]

### Historical findings that must not be carried forward as current facts

The older note reports `result-delivery.ts` and its test as ignored and untracked. [H-old-gaps]
At the inspected checkout both files were tracked, and the package's default test command explicitly includes `result-delivery.test.ts`. [C-package][C-delivery-test]
The older note's pane-retention acceptance gate also conflicts with the new automatic-close requirement. [H-decisions][H-old-acceptance]
It reports installed versions and terminal behavior from an earlier investigation; this research did not re-run Herdr or inspect live panes. [H-scope][H-proof]
Its durable reconnection, replay, direct-entry zoom, and physical-key acceptance items should remain validation requirements rather than claimed completed features. [H-unproven]

## Recommended specification

Everything in this section is a recommendation, not implemented upstream behavior.
The references explain the source constraint or existing contract that motivates each recommendation.

### Core boundary and identity

Retain the existing backend-neutral session seam and add a Herdr interactive Pi adapter with a child-side bridge inside the actual Pi process. [C-interface][U-pi-command][U-child-events]
Use one native session writer shared by terminal input and management commands, not a second headless conversation that attempts to mirror the pane. [C-pi-create][U-resume-start]
Separate attach/detach, interrupt-current-run, terminate-host, close-pane, and delete-history operations rather than overloading scope disposal. [C-interface][C-manager-dispose][U-watch-error]
Persist the parent session ID, managed child ID, native Pi session ID/path, task ID, run ID, launch generation, resolved cwd/policy, controller lease, Herdr endpoint, and current pane handle. [U-running-state][U-session-seed][C-events]
Validate readiness and each reconnect against those identities through private local IPC, rather than trusting labels, inherited environment, or a pane ID alone. [U-child-env][U-activity-validation][U-send-command]
Allow one active controller for a parent identity and one live writer for a native conversation. [U-resume-start][U-parent-shutdown]
Treat a different resumed parent or a replacement pane occupant as a mismatch requiring an explicit outcome. [U-running-state][U-resume-start]
Observe native session changes and require validated rebinding or a visible rejection before the managed association can follow a new conversation or branch. [U-child-tools][U-activity-transitions]

### Completion and automatic closure

Represent conversation lifetime, management task status, run outcome, bridge connectivity, and pane presence separately. [U-child-end][U-running-state][C-outcomes]
A provider turn or `agent_end` alone must not close an interactive multi-step task. [U-child-exit-predicate][U-activity-transitions]
For a one-prompt autonomous task, derive task completion only after the correlated run settles, queued work is drained, and no human continuation or inspection hold is active. [C-pi-settlement][U-child-end][C-events]
For human-led work, require an explicit finish action or task-completion signal while still recording each ordinary run settlement. [U-child-tools][U-child-exit-predicate]
Expose completion policy independently from notification policy and native interactivity. [U-interactive][U-child-end]

Use the following closure sequence as an acceptance invariant: `run settled -> task terminal outcome recorded -> transcript/activity caught up -> durable delivery receipt queued -> native host stopped and acknowledged -> owned pane closed -> archived entry retained`. [U-poll][U-watch][C-delivery]
Queueing the durable result is sufficient before closure; the parent need not already be idle or online. [C-delivery][H-decisions]
If transcript capture, native shutdown, ownership validation, or pane closure fails, retain a visible recoverable record and do not report cleanup success. [U-watch-error][U-poll]
Make repeated closure attempts idempotent and generation-checked so an old cleanup cannot close a reopened child. [U-resume-env][U-close]
After closure, `/subagents` should continue to show the child, its runs, outcomes, transcripts, activity timeline, and a continue action. [C-dashboard][U-widget][U-result-renderer]
Continuing an archived child should reopen its saved native conversation under a new launch generation after checking that no live writer already owns it. [U-resume-start][U-resume-env]

### Granular retained master history

Keep native Pi JSONL authoritative for finalized conversation messages and use a durable normalized journal/index for bridge events, correlations, transient activity, and result receipts. [U-session-result][C-events]
Do not substitute terminal screen text or the reference's overwriting activity snapshot for the transcript. [U-screen][U-activity-schema][U-activity-recorder]
Record input origin, run boundaries, user prompts and steering, assistant text and exposed reasoning, tool IDs/names/arguments, available output/error details, queued prompts, model changes, usage, reconnects, interruption acknowledgements, and pane cleanup outcomes. [C-events][C-transcript][U-activity-schema]
Preserve only reasoning actually exposed by the runtime, and retain its redaction metadata. [C-events][C-transcript]
Define display previews separately from access to complete retained tool payloads or referenced output artifacts. [C-transcript][C-manager-limits]
Keep memory and repaint costs bounded through paging and incremental indexing without deleting durable history when the 64-entry live projection prunes. [C-manager-limits][C-manager-prune]
Use ordered event sequence numbers and run IDs to replay missing data and reconcile out-of-order or duplicated transport messages. [U-activity-schema][C-events]
Preserve `/btw` origin filtering in tools, archives, and result delivery so user-only conversations do not enter the parent model's context. [C-btw][C-delivery]

### Management, navigation, and survival

Preserve spawn, wait, cancel, check, list, and human steering/continuation contracts, adding explicit human visit, finish, and reopen actions where needed. [C-tools][C-wait][C-other-tools][C-takeover-input]
Use acknowledged native interruption and keep `interrupt_requested` distinct from `interrupted`. [U-interrupt][C-outcomes]
Do not use synthetic Escape as the authoritative cancellation protocol when the foreground program might be an editor. [U-send-escape][H-decisions]
Retain the historical lower child region, visit-without-detach, direct-master return, and Ctrl+] native-Escape proposal as the navigation baseline subject to fresh Herdr validation. [H-decisions]
A managed visit should not steal ownership or stop the master and sibling children. [H-decisions]
Defer pane creation or automatic closure if it would disrupt a zoomed visit, and expose pending presentation work independently from task execution state. [H-decisions]
Limit the initial navigation guarantee to one attached Herdr client unless independent-client focus is separately proven. [H-decisions][H-unproven]
Keep Herdr itself unchanged and use an adapter plus terminal wrapper only if the external-editor key policy remains required. [H-scope][H-decisions]
Treat the earlier wrapper/transport proof as a starting point for acceptance tests, not production readiness. [H-proof][H-unproven]

If the historical survival requirement is retained, child hosts must survive controller reload/exit and reconnect only to the same validated parent session. [H-decisions][C-shutdown]
Keep completion receipts deliverable even when a child finishes and closes while the parent is offline. [H-decisions][U-parent-shutdown][U-delivery]
Enforce the four-running-child cap before every run, including native-composer starts, archived continuations, `/btw`, and disconnected-host starts. [C-manager-limits][C-manager-capacity][C-manager-restart][C-capacity-tests]
Separate bridge heartbeat from work progress so long tools and idle humans remain legitimate while a dead bridge becomes visible. [U-test-status][U-live-long-tool]
Retain the standalone headless path outside Herdr and surface inside-Herdr launch/bridge failures explicitly. [C-pi-create][H-decisions]

### Model, resources, and capability policy

Resolve and persist the parent's model and thinking defaults, explicit overrides, trust decision, resource discovery root, effective skill set, and excluded tools before launching. [C-tools][C-trust][C-pi-model][C-pi-resources]
Use the same resolved policy when reopening or resuming instead of reconstructing it from current shell defaults. [U-resume-env][C-pi-exclusions]
Enforce no nested delegation and no forbidden question tools at the native child's actual registration/execution boundary, including after reload and model/tool changes. [C-pi-exclusions][U-registration-deny]
Show effective capabilities in `/subagents`, but treat the display as evidence of policy rather than the enforcement mechanism. [U-child-widget][U-registration-deny]
Keep current Codex permission settings and Claude compatibility scope unchanged by this Pi feature. [C-policy][C-codex-permissions]
Any later Codex-native pane work needs its own adapter proof and externally started-turn handling. [C-codex-filter][H-proof]

## Useful inspirations and quirks not to copy

| Keep as inspiration | Why it is useful |
| --- | --- |
| Real interactive CLI plus an extension inside the child | Native UI and lifecycle events describe the same process. [U-pi-command][U-child-events] |
| Explicit terminal handles independent of focus | Command delivery need not follow wherever the user is typing. [U-send-command][U-cmux-focus] |
| Versioned child-written activity and atomic snapshot replacement | Useful supplementary status cache with schema validation. [U-activity-schema][U-activity-write][U-activity-validation] |
| Separate task artifacts, launch metadata, and native session history | Enables inspection after pane closure. [U-task-delivery][U-command-tail][U-watch] |
| Provider error sidecars and clear failure presentation | Avoids calling a zero-exit harness failure successful. [U-child-end][U-result-presentation] |
| Linked blank versus context-forked conversations | Makes context inheritance an explicit policy choice. [U-session-mode][U-session-seed] |
| Quiet status for human-led sessions | Reduces parent model wakeups without suppressing local UI activity. [U-interactive][U-status-refresh] |
| Layout admission based on readable geometry | Useful principle even though our Herdr arrangement should differ. [U-zellij-layout][H-decisions] |

| Do not copy | Source-backed reason |
| --- | --- |
| README takeover guarantee | Current code and tests intentionally auto-exit after human-origin normal completion. [U-readme-auto-exit][U-child-exit-predicate][U-test-auto-exit] |
| `agent_end` as unconditional task completion | No run/task identity or queue-drain barrier. [U-child-end][U-running-state] |
| Close first, notify later | No durable receipt or transcript flush barrier. [U-watch][U-delivery] |
| Escape delivery as stopped-work evidence | Parent locally forces waiting without child acknowledgement. [U-interrupt][U-status-interrupt] |
| Screen sentinel as authoritative completion | Terminal content is scanned for a fixed uncorrelated pattern. [U-command-tail][U-poll] |
| Unknown sidecars as successful done | Malformed semantics are accepted as success. [U-exit-decode][U-test-exit-decode] |
| Valid snapshot as indefinite liveness | Readable frozen active/waiting data never expires. [U-status-classifier][U-test-status] |
| In-memory running map as durable history | Entries are deleted on completion and shutdown. [U-watch][U-parent-shutdown] |
| Resume by path alone | No writer exclusion or original-policy restoration. [U-resume-start][U-resume-env] |
| Generic `deny-tools` as universal protection | Only this extension's registrations consult the deny set. [U-registration-deny][U-child-events] |
| Implicit fresh-child model and cwd defaults | Parent UI defaults are not resolved and definition cwd uses a different base from the README claim. [U-launch][U-cwd][U-readme-frontmatter] |
| Unconditional steering wakeups | Diverges from our wait-consumption and idle-deferred result policy. [U-delivery][C-delivery][C-wait] |
| Fixed sleep as readiness or stale-lock age as ownership | Neither acknowledges the child process or verifies the lock owner. [U-ready-delay][U-zellij-lock] |
| Broad screen-matching tests as acceptance proof | Some assertions are conditional or do not test the named property. [U-live-basic][U-live-fork][U-live-other] |

## Concise full functionality checklist

These are proposed acceptance requirements for the requested upgrade, with source references to the existing contract or identified gap.

- [ ] One actual native Pi conversation shared by its Herdr UI and management bridge. [C-interface][U-pi-command]
- [ ] Spawn acknowledgement only after validated identity and readiness, with rollback for partial launch. [U-launch-session][U-command-tail]
- [ ] Explicit task, run, native session, parent, launch generation, and pane identities. [C-events][U-running-state]
- [ ] Native input, management steering, queued follow-ups, and human-origin continuations correctly correlated. [C-events][H-decisions]
- [ ] Complete live and archived `/subagents` list, activity timeline, transcript, search/paging, errors, and reopen action. [C-dashboard][C-transcript][U-widget]
- [ ] Tool arguments, output/artifact access, exposed thinking, usage, model changes, and queue state retained at an agreed fidelity. [C-events][C-transcript]
- [ ] Run settlement distinguished from task completion, interruption, process exit, bridge disconnect, and pane closure. [C-outcomes][U-child-end][U-watch-error]
- [ ] Automatic pane closure only after durable transcript/result capture and acknowledged native shutdown. [U-watch][U-delivery]
- [ ] Human visit/inspection and queued-input races cannot silently close active work. [U-child-exit-predicate][H-decisions]
- [ ] Closure retries cannot target moved, replaced, or reopened unrelated panes. [U-close][U-resume-env]
- [ ] Completed child history remains accessible after pane removal and parent restart. [U-running-state][C-manager-prune]
- [ ] Saved conversations reopen with one writer and the original effective launch policy. [U-resume-start][U-resume-env]
- [ ] Existing spawn/wait/cancel/check/list and result-consumption behavior retained. [C-tools][C-wait][C-other-tools]
- [ ] Every eligible run result recorded independently and replayed without duplicate parent wakeups. [C-delivery-map][U-delivery]
- [ ] `/btw` remains user-only across native activity, archiving, and replay. [C-btw][C-delivery]
- [ ] Four-child admission enforced across backends and all native/manual starts. [C-manager-limits][C-manager-capacity][C-manager-restart][C-capacity-tests]
- [ ] Native session switches and branches either safely rebind to the managed child or fail visibly. [U-child-tools][U-activity-transitions]
- [ ] Parent reload/exit/crash behavior and same-parent reattachment defined and tested. [C-shutdown][H-decisions]
- [ ] Readable lower-region layout, visit zoom, direct return, native Escape substitute, Unicode/paste/resize/editor behavior validated. [H-decisions][H-unproven]
- [ ] Pending pane operations remain visible and do not steal focus during visits. [H-decisions]
- [ ] Explicit model/thinking, cwd, trust, skills/resources, and permission inheritance on launch and resume. [C-trust][C-pi-model][U-resume-env]
- [ ] Native no-delegation/question restrictions tested through reload and continuation. [C-pi-exclusions][U-registration-deny]
- [ ] Independent bridge heartbeat, bounded control requests, failure outcomes, and missing-pane detection. [U-status-classifier][U-poll]
- [ ] Headless behavior outside Herdr and visible inside-Herdr failures. [C-pi-create][H-decisions]
- [ ] Fixture tests for correlation/replay plus an isolated real Pi/Herdr session and physical-key/visual acceptance before deployment. [U-test-mock][H-unproven]

## Major user decisions needed before final specification

These decisions are recorded for a later specification review, not questions asked during this research.
Automatic closure and retained granular master history are already explicit in the current request.

| Decision | Recommended baseline | Alternative or consequence |
| --- | --- | --- |
| Meaning of completion | One-prompt autonomous tasks finish after a drained correlated run; human-led tasks require explicit finish. [U-child-end][U-child-tools] | Closing after every ordinary run would interrupt a multi-step human session. [U-child-exit-predicate] |
| Human takeover and inspection | Visiting preserves ownership; active human input or an inspection hold defers closure until finish/release. [H-decisions][U-test-auto-exit] | Source-like auto-exit can close immediately after the human's answer. [U-test-auto-exit] |
| Failure and cancellation panes | Archive every terminal outcome, then close once safe; an abort that leaves the task open is not completion. [C-outcomes][U-child-exit-predicate] | Keeping failed panes for inspection needs a separate configurable hold. [U-watch-error] |
| Parent survival | Retain historical survive-and-reattach semantics for the same parent identity. [H-decisions] | Keeping today's parent-owned teardown is simpler in lifetime terms but changes that earlier proposal. [C-shutdown] |
| Retention fidelity and duration | Full native finalized history plus structured activity/receipts, paged previews, and separately accessible large payloads. [C-transcript][C-manager-limits] | Preview-only retention would not recover complete tool detail after closure. [C-transcript] |
| Parent notification policy | Preserve idle follow-up delivery and wait consumption, per run, with `/btw` excluded. [C-delivery][C-wait][C-btw] | Immediate upstream steering changes active-parent behavior. [U-delivery] |
| Navigation keys and client scope | Carry forward direct Escape return, Ctrl+] native Escape, editor support, and single-client scope subject to proof. [H-decisions] | A different return shortcut avoids overriding native Escape but changes the historical navigation decision. [H-decisions] |
| Fork/context and agent presets | Fresh children inherit explicit live model/policy; context copying is opt-in and branch-aware. [C-pi-model][U-session-seed] | Upstream role presets, nested planners, and Anthropic defaults broaden scope and conflict with current routing. [U-planner-agent][C-policy] |
| Native session switching | Permit only switches/branches that the bridge can validate and adopt into the same managed association. [U-child-tools][U-activity-transitions] | Disabling those commands while managed provides a narrower native interface but avoids ambiguous history ownership. [U-child-tools] |
| Harness scope | Deliver native Pi first behind the existing shared seam. [C-interface][C-pi-create] | Native Codex is a separate scope decision and requires handling externally started turns. [C-codex-filter][H-proof] |
| Running admission while disconnected | Keep the global four-running-child limit, including native human continuations. [C-manager-limits][C-manager-capacity][C-manager-restart][H-decisions] | Allowing unsupervised starts weakens the existing admission contract. [C-manager-capacity][C-manager-restart] |

## Permanent source index

All upstream links below pin `c100577ebf7393a11d098ad9810ec6c269dcfc30`.
All local source and historical-document links below pin the public revision whose compared file contents matched the inspected checkout.

[U-package]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/package.json#L1-L33
[U-readme-flow]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md#L3-L24
[U-readme-tools]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md#L63-L78
[U-readme-modes]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md#L260-L324
[U-readme-frontmatter]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md#L292-L308
[U-readme-auto-exit]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/README.md#L333-L346
[U-entry-imports]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L17-L55
[U-reload]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L60-L85
[U-params]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L87-L130
[U-deny]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L163-L196
[U-frontmatter]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L207-L255
[U-discovery]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L257-L278
[U-cwd]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L280-L305
[U-session-mode]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L307-L332
[U-interactive]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L334-L357
[U-agent-load]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L359-L374
[U-ready-delay]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L383-L394
[U-artifact-path]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L408-L418
[U-result-presentation]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L439-L484
[U-running-state]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L486-L530
[U-widget]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L599-L649
[U-tool-allowlist]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L651-L687
[U-skill-args]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L651-L707
[U-observe]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L709-L750
[U-interrupt]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L752-L835
[U-status-refresh]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L837-L888
[U-launch]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L933-L955
[U-launch-session]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L948-L990
[U-task-wrapper]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L992-L1008
[U-claude-launch]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1009-L1080
[U-pi-command]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1082-L1117
[U-system-prompt]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1096-L1112
[U-child-env]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1119-L1144
[U-task-delivery]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1146-L1174
[U-command-tail]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1176-L1217
[U-watch]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1246-L1331
[U-watch-error]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1332-L1357
[U-parent-shutdown]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1360-L1384
[U-registration-deny]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1386-L1399
[U-spawn-validation]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1417-L1450
[U-delivery]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1452-L1541
[U-list]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1652-L1704
[U-resume-start]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1708-L1804
[U-resume-env]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1806-L1888
[U-resume-delivery]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1889-L1963
[U-commands]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L1966-L2006
[U-result-renderer]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L2008-L2084
[U-plan-command]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/index.ts#L2151-L2180
[U-session-seed]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/session.ts#L20-L68
[U-session-result]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/session.ts#L86-L130
[U-session-helpers]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/session.ts#L132-L180
[U-child-exit-predicate]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L12-L38
[U-child-widget]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L78-L163
[U-child-end]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L165-L213
[U-child-events]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L147-L257
[U-child-tools]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/subagent-done.ts#L268-L323
[U-activity-schema]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L4-L79
[U-activity-path]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L104-L106
[U-activity-validation]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L147-L203
[U-activity-write]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L205-L222
[U-activity-recorder]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L294-L387
[U-activity-transitions]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/activity.ts#L389-L510
[U-status-constants]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L5-L18
[U-status-config]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L140-L188
[U-status-interrupt]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L245-L311
[U-status-classifier]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/status.ts#L313-L437
[U-mux-detection]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L9-L122
[U-zellij-target]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L151-L199
[U-zellij-minimum]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L205-L214
[U-zellij-layout]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L244-L363
[U-zellij-lock]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L457-L497
[U-zellij-create]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L394-L527
[U-cmux-focus]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L617-L741
[U-surface-create]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L744-L809
[U-surface-split]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L815-L905
[U-titles]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L910-L1006
[U-send-command]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1008-L1038
[U-send-escape]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1040-L1064
[U-send-script]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1066-L1102
[U-screen]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1107-L1188
[U-close]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1190-L1216
[U-exit-decode]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1218-L1252
[U-poll]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/cmux.ts#L1254-L1332
[U-claude-hook]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/plugin/hooks/on-stop.sh#L1-L68
[U-plan-skill]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/pi-extension/subagents/plan-skill.md#L13-L35
[U-planner-agent]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/agents/planner.md#L1-L31
[U-scout-agent]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/agents/scout.md#L1-L11
[U-worker-agent]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/agents/worker.md#L1-L11
[U-reviewer-agent]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/agents/reviewer.md#L1-L10
[U-test-mock]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L81-L116
[U-test-result]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L261-L330
[U-test-seed]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L408-L451
[U-test-config]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L480-L563
[U-test-status]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L566-L638
[U-test-skills]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1082-L1113
[U-test-hidden]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1141-L1217
[U-test-auto-exit]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1219-L1295
[U-test-exit-decode]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1297-L1344
[U-test-activity]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1419-L1589
[U-test-interrupt]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L1591-L1891
[U-test-layout]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/test.ts#L2001-L2362
[U-test-system-prompt]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/system-prompt-mode.test.ts#L22-L157
[U-integration-backends]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/harness.ts#L76-L103
[U-integration-focus]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/harness.ts#L116-L161
[U-integration-start]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/harness.ts#L263-L298
[U-live-focus]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/mux-surface.test.ts#L43-L99
[U-live-escape]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/mux-surface.test.ts#L214-L241
[U-live-basic]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/subagent-lifecycle.test.ts#L40-L110
[U-live-long-tool]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/subagent-lifecycle.test.ts#L114-L195
[U-live-fork]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/subagent-lifecycle.test.ts#L199-L245
[U-live-other]: https://github.com/HazAT/pi-interactive-subagents/blob/c100577ebf7393a11d098ad9810ec6c269dcfc30/test/integration/subagent-lifecycle.test.ts#L249-L330
[C-interface]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backend.ts#L22-L66
[C-events]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/domain.ts#L80-L213
[C-outcomes]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/domain.ts#L124-L142
[C-pi-exclusions]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L39-L50
[C-pi-model]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L58-L105
[C-pi-resources]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L97-L105
[C-pi-create]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L262-L309
[C-pi-settlement]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L365-L397
[C-pi-events]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/pi.ts#L399-L483
[C-manager-limits]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L45-L69
[C-manager-prune]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L246-L311
[C-manager-fold]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L314-L419
[C-manager-capacity]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L422-L440
[C-manager-restart]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L624-L655
[C-manager-dispose]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/manager.ts#L624-L679
[C-trust]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L119-L138
[C-delivery]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L180-L248
[C-shutdown]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L250-L263
[C-tools]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L267-L356
[C-wait]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L358-L402
[C-other-tools]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L452-L569
[C-dashboard]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/index.ts#L724-L750
[C-takeover]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/ui/takeover.ts#L56-L100
[C-takeover-input]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/ui/takeover.ts#L409-L490
[C-transcript]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/ui/transcript.ts#L48-L159
[C-btw]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/by-the-way.ts#L18-L21
[C-delivery-map]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/result-delivery.ts#L1-L20
[C-delivery-test]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/result-delivery.test.ts#L1-L17
[C-capacity-tests]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/manager.test.ts#L173-L253
[C-codex]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/codex.ts#L315-L350
[C-codex-filter]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/codex.ts#L584-L606
[C-codex-permissions]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/codex.ts#L884-L898
[C-claude]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/src/backends/claude.ts#L324-L352
[C-package]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/home/.pi/agent/extensions/subagents/package.json#L1-L25
[C-policy]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/agent-capability-policy.md#L3-L15
[H-scope]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L3-L10
[H-decisions]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L12-L45
[H-old-gaps]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L108-L115
[H-old-acceptance]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L218-L238
[H-proof]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L240-L281
[H-unproven]: https://github.com/dimajarkov/dotfiles/blob/bce6ddefc2118fc183064dd3d5cfd3dcd142d581/docs/research/pi-subagents-herdr-panes.md#L293-L299
