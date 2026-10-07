# Native Pi subagents in Herdr panes

## Status and scope

Dmitri confirmed the specification below after a design interview and authorized an isolated feasibility proof.
This is a proposed extension design, not a deployed feature or a configuration toggle.
Herdr itself must remain unchanged.
The active Pi extensions, settings, Herdr configuration, and existing panes must not be modified by the proof.
Research inspected installed Pi 0.99.1, Codex 0.159.3, Herdr 0.9.1, and the deployed subagents extension.
The investigation and proof run on the current terminal stack rather than claiming support for arbitrary terminals or independent simultaneous Herdr clients.

## Confirmed user decisions

1. Entering a child pane does not detach it or transfer ownership away from the master.
   The child remains managed, including result delivery, waiting, and cancellation.
2. Children occupy a tiled region below the master.
   Entering a child temporarily zooms its pane, and returning restores the previous presentation.
3. The master and other children continue working while a child is being visited.
4. Preserve the existing coordination contract rather than adding peer messaging or nested delegation.
5. Finished child panes remain below the master until the user explicitly closes or moves them.
   There is no assumed Herdr pane-archive operation.
6. Pi and Codex children expose their actual native interactive interfaces.
   Claude stays on its existing compatibility path unless separately requested.
7. Plain Escape returns directly to the original master without interrupting child work.
   It does not first reopen the subagent dashboard.
8. Do not modify, fork, or require new features in Herdr.
9. Children survive master reload, exit, or crash.
   They visibly lose their management connection and reconnect only when the same parent session returns.
10. Manually initiated child continuations also deliver their completed results to the master and can wake it.
    Identify the originating turn and human intervention instead of presenting an old answer as the latest task result.
    `/btw` remains user-only and outside the master's model context.
11. Preserve trusted-directory handling, existing permission policy, and the intended prohibition on child question tools and nested delegation.
    Having an interactive interface must not silently add powers.
12. When the child area is too crowded for another usable tile, require manual cleanup rather than silently terminating, relocating, or reusing a child.
    Preserve the four-running-child limit across harnesses for a parent.
13. Limit the navigation guarantee to a single attached Herdr client.
    Do not claim independent multi-client focus.
14. Defer new pane creation during a zoomed child visit.
    Report those tasks as waiting to start, rather than secretly running them without their promised panes.
15. Escape-return applies whenever a managed child pane is focused, including entry by mouse or ordinary Herdr navigation.
    It also applies while an editor or other foreground program is running inside that child.
    Unrelated panes retain their normal key behavior.
16. Ctrl+] sends the child's native Escape action for interruption, dialog dismissal, or editor commands.
17. Outside Herdr, retain today's headless execution and takeover interface.
    Inside Herdr, report pane or bridge failures explicitly instead of silently substituting an invisible child.

## Terminology

- A **managed child** is one conversation associated with one parent session and subject to the extension's orchestration policy.
- A **pane** is Herdr's terminal location, not a conversation or a parent-child relationship.
- A **native conversation** is the actual Pi session or Codex thread that both the user interface and orchestration connection address.
- A **run** is a correlated execution within that conversation, with its own terminal outcome.
- A **visit** changes focus and zoom without changing conversation ownership or interrupting execution.
- **Cancellation** interrupts active work and is distinct from closing a pane or terminating the conversation host.
- **Controller disconnection** removes the master's management connection without implying child completion or process termination.
- **Transcript retention** preserves persisted history and does not imply retention of a live process.

## Current implementation facts

The deployed extension resolves through Home Manager links to the live source at [`home/.pi/agent/extensions/subagents`](../../home/.pi/agent/extensions/subagents).
An already-running Pi process may retain older loaded code until reload even when the filesystem paths match.
The extension registers five model-facing operations: spawn, wait, cancel, check, and list.
Human steering and continuation are available through the takeover interface, but there is no registered master-model send tool or managed peer mailbox.
See [`index.ts`](../../home/.pi/agent/extensions/subagents/index.ts), [`src/prompt.ts`](../../home/.pi/agent/extensions/subagents/src/prompt.ts), and [`src/manager.ts`](../../home/.pi/agent/extensions/subagents/src/manager.ts).

### Execution and communication

Pi children currently use in-process SDK sessions bound in print mode.
Codex children currently use a scoped `codex app-server` with JSON-RPC over piped stdio and one persistent thread.
Claude children use the Claude Agent SDK with a long-lived streaming-input query.
All adapters normalize activity into the manager's event stream rather than asking the UI to interpret harness-native messages.
See [`src/backends/pi.ts`](../../home/.pi/agent/extensions/subagents/src/backends/pi.ts), [`src/backends/codex.ts`](../../home/.pi/agent/extensions/subagents/src/backends/codex.ts), [`src/backends/claude.ts`](../../home/.pi/agent/extensions/subagents/src/backends/claude.ts), and [`src/domain.ts`](../../home/.pi/agent/extensions/subagents/src/domain.ts).

The manager caps running children at four and tracked entries at 64.
Its current scope cleanup terminates owned child execution.
Normal parent session shutdown disposes the runtime, and the manager has no durable reconstruction or reattachment path.
Native session history exists, but opening that history in a second process is not attaching to its original live execution.
See [`src/manager.ts`](../../home/.pi/agent/extensions/subagents/src/manager.ts) and the shutdown handler in [`index.ts`](../../home/.pi/agent/extensions/subagents/index.ts).

Unconsumed results are deferred until the parent becomes idle, while explicit wait or cancellation consumes the corresponding result.
Automatic delivery uses a parent follow-up message and can trigger another parent turn.
The current deferred map is keyed by child ID rather than run ID, so multiple child completions before flushing can replace an earlier pending completion.
See [`src/result-delivery.ts`](../../home/.pi/agent/extensions/subagents/src/result-delivery.ts).

The current takeover is a Pi overlay over the normalized transcript, not the child's native interface.
Escape returns from that overlay to the dashboard, and another Escape closes the dashboard.
See [`src/ui/takeover.ts`](../../home/.pi/agent/extensions/subagents/src/ui/takeover.ts).

### Herdr capabilities and limitations

Herdr supports downward splits, background creation, explicit cwd and environment, exact pane focus through its socket interface, and pane zoom.
Its layout tree represents geometry, not orchestration ownership.
A successful split clears tab zoom even when `--no-focus` is used.
Exact pane focus affects attached shell clients without an initiating-client selector.
These facts motivate single-client scope and deferred pane creation during visits.
The installed CLI and socket schema were inspected, with source corroboration from [Herdr v0.9.1](https://github.com/herdrdev/herdr/tree/v0.9.1), particularly `src/workspace/tab.rs`, `src/app/api/panes.rs`, and `src/server/headless/client_views.rs`.

Moving a pane preserves its process, while closing a pane terminates its owned process.
Cross-workspace moves can change the public pane ID.
A retained original parent association must therefore track stable identity and current handles instead of using an upward neighbor or focus history.
See the [Herdr socket interface documentation](https://herdr.dev/docs/socket-api/) and [session-state documentation](https://herdr.dev/docs/session-state/).

Herdr agent `done` depends on unseen background completion and becomes idle when seen.
That state is not a correlated harness-run completion receipt.
Terminal reads can omit alternate-screen history, so they must not become the authoritative result protocol.
See the installed skill at `~/.agents/skills/herdr/SKILL.md`, `herdr --skill`, and installed `herdr agent` help.

### Existing reproducibility gaps

The extension's development types are pinned to Pi 0.85.0 while the installed host is 0.99.1.
The imported `src/result-delivery.ts` and its test exist locally but are ignored by the repository's `result-*` rule and absent from normal tracked-test discovery.
Installed Herdr Pi and Codex integrations were reported as outdated during inspection.
The current Codex configuration enables native multi-agent behavior even though the extension advertises a no-child-delegation policy.
Do not silently include those existing issues in the pane feature's claimed parity.
Resolve or explicitly account for them before production validation, without changing them as part of this isolated proof.

## Proposed module design

### Keep the existing orchestration seam

The useful existing seam is [`SubagentSession`](../../home/.pi/agent/extensions/subagents/src/backend.ts): metadata, normalized events, send, and interrupt.
Keep callers independent from terminal rendering and harness-native transport shapes.
Two real variations already exist: standalone headless execution and Herdr-backed interactive execution.
Implement those as adapters rather than scattering Herdr conditionals across model-facing tools.

The interface needs a deliberate lifetime change for durable Herdr children.
Closing a controller attachment must release subscriptions and sockets without necessarily killing the child host.
Explicit termination, cancellation, and detachment must not share an ambiguous scope finalizer.
Normal headless execution can retain today's parent-owned cleanup.

### Child host and terminal wrapper

Launch one child host in its real Herdr pane.
That host owns the native execution process and its lifetime independently of the master.
Use a terminal wrapper to reserve Escape and translate Ctrl+] while forwarding the remaining terminal behavior.
A wrapper around pipes is insufficient; native programs need a controlling PTY with correct foreground process groups, terminal modes, and resize propagation.

The wrapper must recognize escape sequences and bracketed paste across arbitrary read boundaries.
It must preserve terminal negotiation, mouse input, Unicode, and supported structured keyboard events.
A delayed Alt sequence and a lone Escape can have identical legacy byte prefixes, so perfect distinction cannot be promised without supported-protocol assumptions.
Consume navigation Escape without forwarding an interrupt, including when return fails because the original master is unavailable.
Report that failure without selecting an unrelated pane or destroying child work.

Nested PTYs can hide the native agent from Herdr's ordinary foreground-process detection.
Use authenticated bridge readiness and explicit public agent/session reports rather than treating visible output or a spawned PID as proof of readiness.
Do not edit Herdr-managed integration files.

### Native Pi adapter

Start an actual interactive Pi process with a child-side bridge extension.
Subscribe to authoritative Pi lifecycle, message, queue, tool, and model events inside that process.
Accept acknowledged management operations over private local IPC.
Preserve resolved model/thinking settings, project trust, resource discovery policy, child tool restrictions, timeout handling, and native session identity.

A Pi terminal-input hook can handle Escape while the Pi interface owns input, but it cannot enforce the confirmed editor behavior by itself.
The wrapper remains necessary for the cross-application return policy.
See installed Pi [extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md), [SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), and the installed 0.99.1 declarations rather than the extension's older development types.

### Native Codex adapter

Use one privately addressable child app-server and one managed thread.
Connect both the native Codex interface and the master controller to that same execution host.
Installed Codex supports native `--remote unix://PATH` and app-server `--listen unix://PATH`.
Unix socket connections use WebSocket framing, not the current adapter's newline-delimited stdio reader.
The exact same-thread attachment and notification behavior must be demonstrated before implementation relies on it.
See the installed CLI help, local Codex source `codex-rs/app-server/README.md`, and [official app-server documentation](https://learn.chatgpt.com/docs/app-server).

The current adapter ignores some execution notifications unless it believes a locally dispatched run is active.
A native interface can start runs independently, so correlation must adopt those runs from authoritative notifications.
Track thread and run identities and distinguish human-origin input from controller-origin input.
Coordinate request response ownership so two attached clients do not answer the same approval request inconsistently.
Preserve autonomous permission policy and explicitly disable forbidden native delegation surfaces.
Do not quietly change Codex's existing queued-follow-up behavior into steering merely because another protocol method exists.

### Durable association and result receipts

Persist a private association record containing the parent session identity, child identity, native session/thread identity, Herdr endpoint, current terminal/pane identity, and launch generation.
Keep native conversation history authoritative in the harness rather than duplicating it in the association record.
Reconnect only after validating those identities and the child host's liveness.
Treat inherited environment values, labels, PID reuse, stale pane IDs, and Herdr layout restoration as insufficient identity evidence on their own.

Use a single active controller lease for a parent identity so two resumed master processes cannot independently steer or deliver the same child run.
A controller lease is separate from the child host lifetime and must be recoverable after controller failure.
Apply admission before every run starts, including manual continuation in retained panes, rather than counting only newly spawned panes.
The four-running-child cap must remain enforceable while the master is disconnected.

Run receipts must include a stable run identity and outcome.
Results from human-origin turns use the same delivery policy as managed turns, except user-only `/btw` children.
Reconcile recorded parent deliveries during reconnect to avoid duplicate wakeups or silently losing a completed run.
Do not claim exactly-once behavior across crashes until persistence and replay tests prove the intended invariant.
Finished-pane retention must not accidentally inherit the current manager's process-killing prune behavior.

### Navigation and layout

Store the original parent association rather than relying on the pane above the child or Herdr's last-pane history.
Finish the `/subagents` picker before focusing the selected child so return lands at the master's normal interface.
Apply the same return key policy when entering a managed child directly.
Automatic zoom on direct entry requires observing Herdr focus changes, not merely intercepting input once Pi receives it.
Remember the relevant focus and zoom presentation and restore it on return.
Follow a valid original parent after moves; do not follow an unrelated replacement occupant.

Allocate a lower child region and subdivide it instead of repeatedly splitting the master downward.
Make the readable-tile threshold explicit and responsive to terminal size.
Reject overcrowding with a clear manual-cleanup explanation.
A pending spawn during a visit remains visibly queued until pane creation is safe.
Manual pane closure must yield an explicit child termination outcome rather than leaving waits unresolved.

## Isolated proof

Prototype code and runtime evidence live under the gitignored directory `.no-mistakes/herdr-subagent-proof/`.
They are deliberately separate from active configuration and must not be committed to this public dotfiles repository.
Scratch repositories can retain throwaway prototype commits without changing the outer repository's branch or index.

The Codex proof tests native same-thread attachment and structured observation of both programmatic and native-interface turns.
The Pi/Herdr proof tests a real native Pi interface, a structured bridge, and terminal-wrapper navigation in an owned test session.
Each proof must bound waits, record failures honestly, and stop only its own processes and Herdr session.
A CLI-driven PTY test is evidence of transport behavior, not complete visual or physical-keyboard acceptance.
Results will be summarized below once the proofs finish.

## Production acceptance gates

- One native conversation is shared by the child interface and master control, with no second transcript writer.
- Both controller-origin and human-origin turns produce correlated start, activity, and terminal outcome events.
- Escape returns directly to the original master without interrupting work or losing editor input.
- Ctrl+] performs native Escape in Pi, Codex, dialogs, and an external editor.
- Ordinary typing, Unicode, paste containing Escape, supported Alt keys, keyboard negotiation, signals, and resize remain correct on the supported terminal stack.
- Child recognition, session identity, startup readiness, and working/idle reporting remain accurate through a nested PTY.
- New children do not unzoom or steal focus during a visit and remain visibly pending until launch.
- Four concurrent starts and manually restarted children cannot bypass the concurrency cap.
- Completed panes are never automatically closed or moved by pruning.
- Cancellation, pane closure, process exit, management disconnection, and waiting interruption remain distinguishable and cannot strand a wait.
- Parent reload, exit, crash, and same-session reattachment preserve live children and reconcile result receipts.
- Moving a pane or replacing its foreground occupant cannot redirect control to an unrelated process.
- Parent disappearance produces an explicit return failure without forwarding an unintended native Escape.
- `/btw` privacy and the standalone headless path retain their existing behavior.
- Inside-Herdr failures are visible instead of silently falling back.
- Forbidden child questions and nested orchestration remain disabled in both native harnesses.
- A final end-user session verifies visual stability and physical-key behavior rather than relying only on synthetic input.

## Proof results

The core transport and navigation mechanics were demonstrated on the installed stack on 2026-10-02.
This is enough to justify a production design, not enough to claim the full specification works.
The parent independently reran both offline evidence checkers without starting applications or requesting additional model turns.

### Codex: same live conversation demonstrated

The native remote interface resumed the exact programmatically controlled thread, session ID, and rollout path.
It adopted an already-running turn through native pagination and successfully steered that turn.
A turn submitted through the actual native composer reached the parent as structured notifications even when the parent had no locally active run.
Parent steering was acknowledged, and interruption of that native-started turn was observed by both clients.
The parent-steering test proves request acceptance, not a completed answer incorporating that steer, because interruption followed immediately.
No conversation fork was observed, and final history contained exactly the two tested main conversation turns.
Keyboard input was synthesized through the native interface's PTY rather than typed by a person.

The stricter claim that the server contained only one loaded model thread failed.
Codex automatically created an ephemeral title-generation thread using `gpt-5.6-luna`, while the main conversation used `gpt-6-luna`.
This did not duplicate the conversation rollout, but suppressing or explicitly accounting for that hidden auxiliary task remains necessary.
The current adapter's externally started-turn filtering must also change before manual continuations can participate in orchestration.

The private primary-source report is `.no-mistakes/herdr-subagent-proof/codex/result.md`.
Recheck its saved wire evidence with `python3 -B .no-mistakes/herdr-subagent-proof/codex/analyze.py`.
The checker intentionally reports the two strict auxiliary-thread checks as false rather than disguising them as passes.

### Pi and Herdr: native terminal routing demonstrated

All 18 recorded check groups passed, including a separate group of ten synthetic parser cases.
The live proof used a real Pi interactive process in a downward-split Herdr pane, a private structured bridge, and a single isolated Herdr client.
Escape returned to the captured test parent while Pi remained busy and later completed normally.
The independent master heartbeat continued during the visit.
Ctrl+] reached both native Pi and real Neovim as Escape.
Escape also returned from Neovim without terminating the editor, and revisiting preserved the editor interaction.
Bracketed paste containing both reserved control bytes arrived unchanged, and resize propagated through Herdr and the wrapper to Pi.
A harness-held split waited until return, and the finished child remained present until explicit test teardown.
These are demonstrations of the underlying mechanics, not deployed parent-agent management or a production spawn queue.

The private primary-source report is `.no-mistakes/herdr-subagent-proof/pi-herdr/evidence/result.md`.
Recheck the retained evidence with `python3 -B .no-mistakes/herdr-subagent-proof/pi-herdr/verify.py`.

### Containment exception and cleanup

All identified owned proof processes were stopped and reaped, and their sockets and Codex credential copies were removed.
No Herdr patch, active extension/configuration deployment, or active-session operation was performed.
An earlier editor attempt inherited the macOS temporary-directory location and left a confirmed harmless test artifact outside the approved scratch tree.
Its location is `/var/folders/dh/8gfrsysn4jj6_8s6s5cn69940000gn/T/pi-editor-4Cwghn`.
The earlier editor attempt's implicit cache/data/state writes were not comprehensively audited, so the entire investigation cannot be described as having zero outside writes.
The final harness redirects those locations into its owned directory.
Dmitri subsequently authorized cleanup of that exact leftover.
The parent verified that it contained only one regular file, `prompt.md`, with the harmless text `native editor marker`, and removed only that file and its directory.
The removal receipt is `.no-mistakes/herdr-subagent-proof/cleanup-supplement.json`.
No additional editor cache/state cleanup was performed, and the earlier audit uncertainty remains.

### Still unproven

Durable same-parent reattachment, crash recovery, result replay, permission-request ownership, cross-child admission, and production orchestration integration remain untested.
Automatic zoom from direct mouse or ordinary Herdr entry and exact restoration of an arbitrary prior presentation were not demonstrated by the harness's explicit focus/zoom calls.
Physical-keyboard and pixel-perfect visual acceptance remain outstanding.
The legacy Escape/Alt distinction remains a 40 ms heuristic and is not a universal terminal guarantee.
Do not deploy this proof as the finished extension.
