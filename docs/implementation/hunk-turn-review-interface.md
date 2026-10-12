# Hunk turn review runtime interface

The implemented backend protocol is version 1.
This is the shared runtime contract consumed by the Hunk extension and native adapters.
The backend has no runtime npm dependencies and runs on Node 22.
The new package pins Bun 1.3.14, TypeScript 5.9.3, oxlint 1.87.0, and oxfmt 0.72.0 as local development tools.

## Transport and ownership

`home/.local/share/hunk-turn-review/client.mjs` exports `createClient({socket, timeoutMs?})` and `canonicalCheckout(path)`.
`request(method, params)` returns a promise.
`canonicalCheckout` resolves the complete Git worktree root, including when the native working directory is a subdirectory.
The owner-private Unix socket accepts one UTF-8 newline-delimited JSON request per connection: `{version:1,id,method,params}`.
Responses are `{version:1,id,result}` or `{version:1,id,error:{code,message}}`.
Protocol versions and response IDs are checked, and state mutations are serialized and durably acknowledged.
Core requests are limited to 4 MiB plus 64 KiB of transport overhead, and client responses to 256 MiB.
Native admission receivers accept at most 16 MiB; oversized frozen feedback is retained as blocked before any admission attempt.

State directories are nonsymlink directories owned by the current UID with mode 0700, outside every Git checkout.
Sockets and mutable files use mode 0600, and immutable content files use mode 0400.
Content-addressed files are verified with SHA-256.
Atomic replacement, file fsync, directory fsync, and an exclusive runtime lock protect durable state.
Development uses `node <package>/dist/src/runtime.js --state <absolute-directory> --socket <absolute-socket>` after `bun run build`.
Main's package flattens emitted modules and installs `node <package>/dist/runtime.js` with the same arguments.
The runtime accepts `--pluginId`, `--entrypoint`, and `--maxBytes` for installed configuration.

## Session and request observation

`session.attach` takes `{identity:{kind:"pi"|"codex",nativeId,sessionPath?,checkout},epoch,receiver?,layout?}` and returns `{sessionId,...status}`.
Session IDs are stable across original-session resume and exclude the runtime epoch.
A fresh epoch cannot replace a living original receiver.
An original-session resume after receiver exit preserves review history and interrupts any unfinished interval before accepting new work.
`session.find` takes `{kind,nativeId,checkout,sessionPath?}` and refuses missing or ambiguous identities.
`receiver` is a private original-process receiver socket, including for the Codex observer.
`layout` is `{session,socket,paneId}` supplied by the named Herdr session, rather than a focused-pane lookup.

`request.begin` takes `{sessionId,epoch,requestId}` and awaits watcher arming and the complete eligible pre-response baseline.
The inventory uses Git's tracked and nonignored untracked paths, including pre-existing dirty files, additions, and deletions.
Snapshots preserve bytes, permission bits, and symlink targets without following symlinked ancestors or external targets.
`request.reconcile` takes `{sessionId,epoch}` at tool, lifecycle, and final boundaries.
`request.complete` takes `{sessionId,epoch,requestId,outcome:"completed"|"interrupted"|"failed"}` and publishes an immutable review.
`request.bind` takes `{sessionId,epoch,expectedRequestId,requestId}` and changes only the identity of an already armed interval after authoritative native identity becomes available.
Codex uses this for a concurrent native user turn that wins ahead of a prearmed feedback batch; it never compares prompt strings.
`session.detach` interrupts unfinished observation and preserves review state.
Receiver disappearance and runtime restart also publish interrupted intervals.
`session.warn` persists a visible native integration warning for the Hunk client.
`task.reset` explicitly starts the next cumulative task and requires `{discardPending:true}` to discard pending notes.

Ordinary reviews use the label `changes observed during this response`.
Cumulative reviews use `changes observed during this task`, beginning before the first observed editing request and excluding pre-existing changes.
These labels do not attribute concurrent shared-checkout writes to an agent.

Pi's explicit `all` queue selection is represented by optional `requestGroup:{mode:"all",requests:[{id,source,delivery,correlationId?}]}` on `request.begin` and `request.bind`.
The native `requestId` identifies the one actual group response; the ordered members retain all original UUIDs and routing/correlation provenance without prompt text.
There must be at least two distinct member IDs, each different from the response-scope ID.
Binding a prearmed feedback interval preserves its first baseline and adds this group metadata before any corrective work.
The immutable `review.get` response includes `requestGroup`, while `review.status.active.requestGroup` and `review.status.latestRequestGroup` expose active and latest group provenance.
The response label is `changes observed during intentional Pi all-mode group: N user requests`, which the existing snapshot adapter includes in its title alongside the actual outcome.
Group completion, failure, or interruption publishes one review, rather than separate member outcomes or attributed diffs.
Ordinary one-at-a-time responses retain their ordinary label and individual review; cumulative task reviews omit `requestGroup` because they span multiple response scopes.

## Review and notes

`review.status` takes `{sessionId}` and returns active observation, selection, latest/pinned/cumulative IDs, notes, batches, warnings, layout state, and derived `admittedNoteIds` from known queued immutable batches.
The Hunk entrypoint must keep a waiting or in-progress view alive when `latest` is absent.
`review.get` takes `{sessionId,selection?:"latest"|"cumulative"|"pinned",reviewId?}`.
It returns immutable `{id,requestId,outcome,label,createdAt,changes:[{path,before,after}]}`.
Each side is null for absence or `{kind:"file"|"symlink",mode,sha256,content}`.
File content is base64 and symlink content is the link target.
`review.select` changes selection, and `review.pin` explicitly pins an immutable review.

`note.save` takes `{sessionId,reviewId,note:{id?,text,path?,side?,line?,context?}}`.
The optional context is preserved JSON data, and supplied file anchors must belong to the immutable review.
Saving a draft updates that draft; editing a submitted or closed note creates a new draft ID while keeping the submitted revision and every frozen batch intact.
The Hunk client retains native human note identity and revision provenance in context.
`note.discard` and `note.resolve` are explicit operations on `{sessionId,noteId}`.
Drafting and saving never send feedback.
Pending comments pin their original review, while an admitted batch alone does not permanently prevent following the newest completed response.
Explicit manual pins remain available separately.
The Hunk host validates and restores native source semantics through its public generation 29 interface.
The core owns durable checkpoint storage in its existing private serialized state; the extension owns no second checkpoint database.
`review.checkpoint.read` takes `{sessionId,reviewId}` and returns `{version,checkpoint}`, with `{version:0,checkpoint:null}` when none exists.
`review.checkpoint.write` takes `{sessionId,reviewId,checkpoint,expectedVersion}` and returns `{version}` only after the whole write is durable.
`expectedVersion` is mandatory compare-and-swap authority from the matching read or last acknowledged write.
A stale writer, mismatched canonical checkout, foreign review, altered document identity, inconsistent native notes, or oversized JSON is refused without changing the previous checkpoint.
Checkpoints are bounded to 4 MiB, JSON depth 64, and 2,048 saved native human notes.
Native opaque context, IDs, provenance, draft/edit/reply ownership, selection, generation, and state revision are retained.
An unsaved composer pins its original review but never creates an actionable core note.
The checkpoint and derived saved-note revisions and pin state are replaced in one durable serialized mutation.
The first saved revision uses its native note ID; subsequent immutable core revision IDs are explicitly derived as `<nativeId>@<revision>`, with original `nativeNoteId`, `revision`, `note`, `provenance`, and `reviewId` preserved in `note.context`.
Editing retains every submitted revision and frozen batch while producing a new unsent revision.
The shared public `nativeNoteRevision(note,provenance)` helper excludes renderer reconciliation and explicit note disposition from instruction identity.
Native resolution is explicit and admission never changes it.
`task.reset` also protects active composers, requires explicit discard, and clears discarded checkpoint state so resume cannot resurrect it.

The extension registers `hunk.registerReviewPersistence({open,write})` during factory registration.
`open` binds to the exact immutable snapshot already loaded by its VCS adapter before any await, validates the host checkout/source/document identity, and reads only that snapshot's checkpoint.
It opts out while the first response is still waiting and has no immutable snapshot.
The view remains mounted and follows the first completed response without relaunch.
`write` awaits the core command before native Ctrl-S acknowledges a save.
Explicit switches use the host's guarded `mode:"explicit"` transition, checkpoint the outgoing native state, and restore only the incoming review's checkpoint.
Automatic following acknowledges only exact known-admitted native revisions through `acknowledgedNotes` with an expected host generation/state revision.
Open submitted notes remain editable and unresolved, while active composers, unsent revisions, manual pins, source editors, pending saves, and changed generations remain guarded.
No private Hunk imports or resolved-status workaround is used.
Host generation 29 already provides the required generic acknowledgement capability; no additional Hunk host request is outstanding.

## Feedback and native receivers

`batch.create` takes `{sessionId,noteIds,reviewId?,expectedCheckpointVersion?}` and freezes notes, original immutable diffs, anchors, identity, and a stable batch UUID.
The owned Hunk Send/export action selects only already durable checkpoint-derived revisions; it never calls `note.save` to manufacture a second source of truth.
Owned `batch.create` and `batch.submit` include `reviewId` and `expectedCheckpointVersion` to refuse another viewer changing the durable native state during preparation or confirmation.
Creating a batch does not request delivery.
`batch.submit` explicitly requests admission and records that intent before contacting a receiver.
Busy sessions keep a durable pending batch for a deferred idle boundary.
Receipt states are `pending`, `submitting`, `queued`, `uncertain`, `blocked`, and `discarded`.
A queue receipt means admission, rather than consumption, completion, or resolution.
`batch.reconcile` checks the original native queue/history without retrying.
`batch.retry` takes `{sessionId,batchId,confirmUncertain?:true}` after `batch.reconcile`.
Authoritative absence permits ordinary explicit retry.
If reconciliation remains unknown, retry requires the explicit `confirmUncertain:true` flag and a visible confirmation that retrying may duplicate instructions.
Unconfirmed unknowns, unreconciled receipts, unknown or busy original receiver identities, discarded batches, and known queued batches cannot retry.
The original identity and epoch are checked again, and an interrupted observation from an earlier ambiguous attempt is retained before a confirmed retry begins.
No uncertain batch is automatically retried.
Feedback includes actual human instructions, frozen context, current-code checks, and a request to clarify stale intent.
It does not assume that a note authorizes editing or impose a new commit approval gate.

Receivers use the same v1 transport and validate identity plus epoch for `admission.check`, `admission.enqueue`, and `admission.reconcile`.
The Pi receiver runs in the original Pi process and revalidates native UUID, transcript path, canonical checkout, idle/compaction state, and context generation immediately before synchronous `pi.enqueueMessage`, with no intervening await.
Admission from `agent_settled` is deferred until its handler has returned because the installed native patch lacks a submission deferral guard.
Pi queue memory and persisted custom-message batch IDs reconcile receipts; absence after a crash remains unknown because its follow-up queue is memory-only.

Codex's observer uses RFC 6455 over the exact injected private Unix app-server endpoint, without default endpoint inference or reconnection.
It verifies the original loaded thread, canonical checkout, transcript path, and native status before queue admission.
The observer leaves native approval, tool, user-input, and authentication requests to the original UI and does not alter gateway authentication settings.
It uses `thread/queue/add` with `clientUserMessageId`, then reconciles paginated queue and user-message history by that ID.
The ID is evidence and is not assumed to make the server deduplicate.
Authentic awaited `UserPromptSubmit` hooks arm observation before work, while native `turn/completed` publishes the final response, including Stop-driven continuation.
The SessionStart observer readiness wait is bounded; failures leave coding available and produce a visible hook warning.
The additive fragment in `home/.codex/hunk-turn-review/hooks.fragment.json` preserves existing generated Herdr and Plannotator integrations.

## Herdr and retention

Herdr protocol 22 and the installed plugin entrypoint must be available before automatic layout is attempted.
The first verified change opens the configured argv entrypoint immediately to the original native session's right with `focus:false`.
Original native identity and canonical checkout select the target, and opaque terminal identity follows owned pane movement.
The same installed entrypoint serves both split and tab placement.
No repo-selected executable, private launch script, terminal paste, automatic rearrangement, or focused-pane default is used.
A split requires at least 40 columns on each side; an unusable or unverifiable width visibly offers the full-width tab.
`layout.reopen` reuses a living owned pane and is explicit after closure.
`layout.tab` explicitly opens the full-width review without focusing it, including after original exit when the verified original workspace remains.
Creation intent is durable before the native open call, and actor tokens reconcile an existing owned pane after a crash.
An uncertain open without a provable owned receipt remains uncertain and does not create duplicates.
Manual closure opts out of automatic reopening for that native session.
Main's Hunk entrypoint receives `HUNK_TURN_REVIEW_SOCKET`, `HUNK_TURN_REVIEW_SESSION_ID`, and `HUNK_TURN_REVIEW_ACTOR_ID`.

`maintenance.run` performs retention explicitly, and the runtime also maintains history hourly and after response completion.
Other review history, closed notes, and discarded batch history expire after 30 days and may be pruned earlier under storage pressure.
The default cap is 1 GiB for core snapshot, review, note, batch, and durable index data.
Active task baselines, active observation, explicit pins, and pending human feedback remain protected until explicitly discarded or resolved.
Protected data exceeding the cap is preserved with a visible warning.
Native harness transcripts and main-owned listener logs remain under their respective owners.

## Required Pi host support and main integration

The original installed Pi 1.1.0 proof did not expose a stable external request ID through both queue admission and later consumption, and `agent_settled` followed the combined run rather than each distinct queued user request.
The original native busy-input test confirmed that gap; its adapter retained the interval with the label `changes observed across unseparated Pi user requests` rather than inferring identity from repeated or transformed text.
Full latest-user-request semantics for queued Pi requests require the focused host patch owned by main, which is being integrated separately from this checkpoint continuation.
That patch must carry stable request identity and origin through input/queue/consumption, emit an awaited pre-work request boundary, and emit a per-request final boundary after its tools, retries, and automatic continuations but before the next external request consumes work.
The existing synchronous custom-message admission can remain the feedback seam.
No Nix patch was changed by this backend slice.

Main installs the inspected review manifest, exact paths, private runtime, additive Codex fragment, and exact original Codex endpoint launcher.
Main owns native hook approval, packaging the matching Hunk source and declarations, installation/activation, commits, final Standards/Spec reviews, and broad TUI/Hunk acceptance.
Declarations are generated with `bun generate-host-types.ts <host-checkout>/packages/hunk/src/extension-api/types.ts`; `.host-types` stays generated and ignored.
Unbound/manual reviews retain exports and existing configuration but refuse safe sending because they lack an original native-session binding.
The legacy terminal-prompt helper also refuses delivery, including apparently compatible settled agents; no terminal-paste compatibility fallback is retained.
Human instructions remain free-form and ordinary safeguards apply without categorical edit intent or commit prohibitions.
Backend tests use real Pi 1.1.0, native app-server 0.162.1, and named isolated Herdr 0.9.3 sessions with local deterministic providers.
The earlier complete green run covered the actual Codex SessionStart/prompt/Stop path, Stop continuation, synchronous Pi admission and deferred busy delivery, replacement refusal, crash interruption, and right/no-focus layout with both native harnesses.
The Codex Herdr proof uses the original native app-server in its owned pane; it does not claim activated CLI 0.160.1 TUI or Hunk visual acceptance.

## Verification

The core developer typecheck (`bun run typecheck`) checks the complete strict project, including the native Pi adapter, against the installed Pi package's public `@earendil-works/pi-coding-agent/dist/index.d.ts`, then checks the remaining adapter configuration.
It discovers the SDK from the `pi` executable on `PATH`; when checking a separate profile, set `PI_TEST_PACKAGES=<profile>/lib/pi-coding-agent/packages`.
The selected public declaration must export `UserRequestScope`, so a missing or stale SDK fails with setup guidance instead of weakening the check.
The generated TypeScript config is temporary and removed after the check; no copied declarations or Nix store paths are committed.

Run from `home/.local/share/hunk-turn-review`:

```sh
bun run format:check
bun run typecheck
bun run lint
bun run test
```

The original backend baseline passed 16 tests / 109 assertions. This continuation used red/green vertical slices at the actual runtime/socket command seam and the public Hunk factory/persistence/action seam. Initial failures exposed missing checkpoint commands and persistence registration, missing unsent native revision/composer protection, refusal of risk-confirmed unknown retry, and unsafe legacy terminal delivery. The previously failing absent-retry scenario was reproduced independently and corrected by giving every scenario its own checkout, native session, and receipt.

Representative continuation red/green commands, from the core directory:

```sh
bun test tests/runtime.test.ts -t "whole native checkpoints"
bun test tests/runtime.test.ts -t "native saved revisions"
bun test tests/runtime.test.ts -t "retention preserves native composers"
bun test tests/runtime.test.ts -t "unknown admission permits"
bun test tests/herdr-codex-live.test.ts -t "isolated Herdr and original"
```

From `home/.config/hunk/extensions/human-review`:

```sh
bun test snapshot-adapter.test.ts -t "public persistence opens"
bun test snapshot-adapter.test.ts -t "explicit Send review freezes"
bun test snapshot-adapter.test.ts -t "reconciliation does not resubmit"
bun test snapshot-adapter.test.ts -t "uncertain feedback reconciles"
bun test snapshot-adapter.test.ts --test-name-pattern "a reconciled absent batch"
bun test workflow.test.ts -t "unbound manual reviews refuse"
bun run format:check
bun run lint
bun run typecheck
bun test
```

All 14 snapshot-adapter scenarios also passed separately with their exact test-name patterns; none relies on test order. The final extension run passed 26 tests / 127 assertions, formatting, lint, and typecheck.

The complete core/native run initially passed 20 tests / 147 assertions, formatting, lint, and both typechecks during this continuation. A subsequent large-checkpoint verification added one meaningful transport case: native context above 1 MiB survives exact restart restoration, while oversized input leaves the durable checkpoint and derived notes unchanged.

After main concurrently changed the separate Pi adapter, the final full core run was **20 pass / 1 fail** across 21 tests. The original native Pi scenario failed with `agent_before_settle requested continuation without runnable model context`; the real Codex app-server and both isolated Herdr scenarios passed. Broad formatting and typecheck also currently flag the main-owned `home/.pi/agent/extensions/hunk-turn-review/index.ts` (including the changed Pi SDK import). Those are current integration failures for main, not green acceptance claims. No adapter source or native host patch was edited by this continuation.

Final owned runtime verification passed 17 tests / 121 assertions, including the large-checkpoint case. Scoped core types, lint, and formatting passed with:

```sh
bun test tests/runtime.test.ts
./node_modules/.bin/tsc --noEmit --target ES2023 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck --allowJs --types bun src/*.ts tests/*.ts client.mjs
./node_modules/.bin/oxlint --deny-warnings src client.mjs tests
./node_modules/.bin/oxfmt --check src client.mjs tests
```

From the repo root, the supporting actual Hunk generation-29 PTY proof passed:

```sh
uv run home/.config/hunk/extensions/human-review/turn-review-pty.py --hunk-source <matching-hunk-checkout>
```

It uses the actual core runtime/socket/client, public Hunk factory, native keyboard editor and persistence controller. It verifies waiting before the first immutable snapshot, captured source after checkout changes, native Ctrl-S durability, composer restoration after SIGKILL, review-isolated checkpoint restoration, unsent pins, explicit Send with immutable original batch context, admitted open-note automatic following, subsequent editing with the same native ID, and unbound manual export with safe delivery refusal. Only the external native admission receiver is simulated in this supporting proof; the separate real native tests are retained.

Latest proof artifacts are in `/private/tmp/hunk-turn-pty.86gleszp`, including `waiting-screen.txt`, `crash.ansi`, `owned-integration.ansi`, and `restored-checkpoint.json`. The reviewed immutable ID is `8375679ad02be5c6ca5c13ee50dc30abd927765009dd144658d1be4d5c8bac09`. Final core/UI logs are `/private/tmp/slot13-core-final-tests.log`, `/private/tmp/slot13-core-runtime-final.log`, and `/private/tmp/slot13-ui-final-tests.log`.

No permanent integration-pending scaffolding remains. No additional Hunk host capability is requested: generation 29's persistence and guarded exact-revision acknowledgements cover this scope. This continuation staged, committed, installed, and activated nothing; slot13's durable lease, current master, and existing `.lavish` artifacts were preserved. Global native visual acceptance remains with main; the denied WezTerm Computer Use path was not bypassed.
