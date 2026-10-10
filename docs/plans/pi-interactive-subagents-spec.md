# Interactive subagents in Herdr

## Status and approval

Dmitri approved interview recommendations Q1-37 and requested that the subagents skill be updated with the feature.
Dmitri confirmed this consolidated specification and requested ticket decomposition.
The approved 23-ticket breakdown is published on GitHub with verified native blocking relationships.
See the [published ticket index](pi-interactive-subagents-tickets.md#published-issue-index).
Approval of this specification is not authorization to implement, run live proofs, deploy, or change active configuration.
Only specification and research documents have changed during this interview.

The reference is [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents/tree/c100577ebf7393a11d098ad9810ec6c269dcfc30), pinned to commit `c100577ebf7393a11d098ad9810ec6c269dcfc30`.
Its native-child patterns are inspiration, not a package to install or a behavior contract to copy.
Historical decisions in `docs/research/pi-subagents-herdr-panes.md` are superseded wherever they conflict with this specification.
In particular, successful finished panes close automatically, and Escape retains its native behavior.

## 1. Scope and compatibility

Provide actual native interactive Pi and Codex conversations in Herdr panes while retaining master coordination and detailed `/subagents` inspection.
The terminal interface and master controller must address the same native conversation, not two conversations with mirrored text.
A human visit or instruction does not detach the child or transfer management away from the master.
The master and sibling children continue working during visits.

Implement through the extension, helper processes, and existing Herdr interfaces without patching Herdr.
One declarative Herdr return-shortcut binding is explicitly within scope.
Pi/Codex native lifetime, explicit task completion, durable recovery, and pane policies apply inside Herdr only.
Outside Herdr, preserve existing headless execution and takeover behavior.
Claude remains on its existing compatibility path and is not migrated to native panes or the new survival/completion lifecycle.
Inside-Herdr failure of a native Pi/Codex launch or bridge is explicit and must not secretly substitute headless execution.
Existing headless and compatibility runs still count toward the master's concurrency limit while they are executing.

Preserve current harness/model routing, reasoning defaults, permission policy, project-resource trust decisions, and the feature-only Codex `/goal` rule.
Preserve existing tool names and add only controls required by this feature.
Do not import upstream agent presets, nested planning workflows, `/plan`, or `/iterate`.

Approval trace: Q1, Q3, Q5, Q13, Q23, Q37.

## 2. Conversation, task, run, and attachment

A managed child is one conversation associated with one original master session.
A task is an assignment within that conversation and can contain multiple execution runs.
A run is a correlated execution with an initiating actor and an explicit outcome.
A pane attachment is the child's current terminal presentation, not its conversation identity or task state.
A visit changes presentation and focus without changing management ownership.
A Keep open hold prevents successful automatic pane closure independently of task completion.

Track task state, run outcome, management connectivity, pane presence, and cleanup status separately.
Idle, run settlement, bridge disconnection, process exit, and Herdr's `done` state are not proof of assigned-task completion.
Each task/run, native conversation, parent association, and pane attachment generation must have a stable identity appropriate to its lifetime.
Human-origin instructions must be distinguishable from master-origin instructions in retained history.

Keep the assigned native conversation identity fixed while managed.
Allow ordinary interaction and model/thinking changes under existing policy.
Reject native conversation replacement, session switching, and forking that would break the association.
Explicit parent-context copying creates a distinct child conversation; it does not permit switching an existing managed child to a different conversation.

Approval trace: Q2, Q3, Q16, Q22, Q27.

## 3. Launch, admission, and layout

Default to the master's working directory and a fresh self-contained task prompt.
Preserve explicit `working_dir`, model, and reasoning overrides with existing trust and capability handling.
Offer explicit branch-aware parent-context copying; it is a snapshot, not automatic full-history copying or live synchronization.
Copy only the selected parent-model-visible branch context, excluding user-only aside entries.
Do not copy unrelated branches or pretend copied context makes a child part of the parent's native conversation.

Keep a maximum of four actively executing managed runs per master across all harnesses and origins.
Admission must happen before model/tool execution, including native human starts, master sends, reopened children, and offline human continuations.
Reading history or keeping an idle pane open consumes no execution slot.
A needs-guidance child releases its slot only after its execution genuinely stops; answering it requires admission again.
Reserve launches atomically and release failed-start reservations only after confirming that no child execution remains.

Place native children in a readable tiled region below the master without stealing focus on creation.
Do not rearrange unrelated panes, create overflow tabs, or secretly run pending children headlessly.
When capacity, readable space, or non-disruptive presentation is unavailable, expose a waiting-to-start state with its reason.
Start queued work when those conditions permit.
Do not split panes during a zoomed visit in a way that clears or disrupts that visit.

Use explicit configurable readability thresholds, validated against the actual native interfaces rather than untested constants.
If resizing makes the layout crowded, pause new pane starts and expose the crowding state.
Existing children remain managed and are not killed or relocated because of window size.
Manual pane movement keeps the child managed by following validated identity and current handles.

A running-state acknowledgement requires validated child identity, policy, bridge readiness, and pane attachment, not a fixed sleep or a visible prompt.
Partially failed launches must retain a diagnostic and safely clean up only their own resources.

Approval trace: Q7, Q11, Q12, Q14, Q20, Q25, Q35.

## 4. Master inspection and human visits

Keep `/subagents` as the master dashboard for live and archived native children.
Enter opens the detailed transcript view, preserving today's inspection-first experience.
A separate Open pane action visits an existing native attachment.
An explicit Resume in pane action reopens an archived conversation without creating a new conversation.
Opening or reading archived details never launches execution.
The resume action must distinguish opening an idle native interface from admitting a new task/run.

Keep granular activity, transcript, outcomes, current task/run state, queue state, model/effort, usage, connectivity, and cleanup diagnostics inspectable.
Provide a Keep open action and show when a completed pane is awaiting closure because of a visit or explicit hold.
Retain the ability to send instructions and request cancellation from the master interface.
Archived inspection must not accidentally restart a child through ordinary text entry.

Visiting temporarily zooms the child, and returning restores the pre-visit presentation.
Direct entry through Herdr navigation or mouse counts as a visit, not only entry through `/subagents`.
Guarantee automatic focus/zoom navigation for one attached Herdr client initially.
If initiating-client targeting is ambiguous, refuse automatic focus changes while keeping execution/history available.

Use Herdr `prefix+enter` to return to the original master, meaning Tab then Enter with the current prefix.
Implement it as one declarative shell-command binding and an identity-aware helper, covering native Pi, Codex, and terminal editors.
Keep Escape and raw Ctrl+] native.
Resolve the original master by its validated session and current attachment, including after moves, rather than by spatial neighbor or focus history.
If the original master is unavailable, report the failure visibly and keep the child intact.
The helper must not rely on stdout/stderr for user-visible errors because Herdr discards shell-command output.
This cross-application shortcut covers applications inside the pane, not unrelated GUI applications or every Herdr modal surface.

Leaving a successfully completed child releases its visit hold, but an explicit Keep open hold remains until released.
Do not assume cross-harness detection of unsent drafts.
Make the Keep open behavior discoverable before a user leaves a completed pane with a draft or planned follow-up.

Approval trace: Q6, Q7, Q8, Q10, Q26, Q27, Q30, Q31.

## 5. Instructions, guidance, and completion

Add master-to-child instruction sending, following the existing `subagent_*` naming convention.
Default to a queued follow-up and expose explicit live steering where the harness supports it.
Report unsupported steering explicitly instead of silently treating it as a queued follow-up.
Both modes address the same managed conversation and record input origin, admission, and execution correlation.
A local send acknowledgement must distinguish receipt, queue admission, and execution rather than claim that invoking a void-returning frontend method proves success.

Keep native child orchestration restrictions in force after launch, reload, resume, model changes, and tool changes.
Children cannot create nested agents/workflows or use direct question tools.
Managed-child mode must also prevent recursive command routes such as `/btw`, not merely hide exact tool names.
A model-visible child needing clarification uses an explicit needs-guidance signal, stays open, and notifies the master.
Private-aside guidance uses a human-only UI path and does not notify the master model.
A human can supply guidance through the native interface, and the master can send it through the management control.
Preserve broad host permissions under existing policy; these orchestration restrictions are not an operating-system sandbox.

Add a dedicated finish action with a final result for both child and human use.
It requests assigned-task completion rather than immediately shutting down the process.
Completion must wait for correlated execution and queued work to settle safely.
If new instructions are admitted while a finish request is pending and before closure starts, revoke that request and require a fresh finish signal.
If the preceding task already has a persisted terminal outcome while its pane remains held open, preserve that outcome, cancel its pending close, and treat new instructions as a new task in the same conversation.
Never retract or overwrite an already-delivered historical task result to represent later instructions.
Once closure starts, reject new work for that attachment with an explicit resume path.
Normal run settlement without a finish signal remains visible but does not automatically complete the task or close its pane.

Preserve `subagent_spawn`, `subagent_check`, `subagent_list`, `subagent_wait`, and `subagent_cancel`, with richer native lifecycle information where needed.
For native tasks, waiting is about assigned-task outcomes, not merely the next idle state.
A needs-guidance state ends a blocking wait with an action-needed result, not success; report other requested children's states and leave them working.
Aborting a wait only stops waiting.
Cancellation of child work remains a separate acknowledged operation.
Keep existing headless/Claude waiting and completion behavior on their compatibility paths.

Approval trace: Q16, Q17, Q18, Q22, Q24, Q25, Q34, Q37.

## 6. Outcomes, process cleanup, and pane closure

Successfully finished tasks close their native panes automatically unless a visit or Keep open hold is active.
For successful completion, a hold defers the shutdown/closing transition itself, not merely the final pane-close command.
The completed task's retained result may still be delivered while the native interface stays open.
Uncertain visit state also holds the pane open, including completion racing with direct Herdr entry.
Failed tasks retain their panes for diagnosis and preserve their partial output.
An explicitly cancelled task closes its pane only after execution stops and history is saved.
Visit and Keep open holds protect successful automatic closure, rather than turning explicit cancellation into an unacknowledged operation.
Manual pane closure records interruption rather than inferring task success and cleans up independently owned execution.
Its minimum history guarantee is recovery through the last durable native/journal event.
Expose that durable cutoff and mark unconfirmed later activity as missing or unknown rather than claiming a complete transcript.
A validated task outcome already persisted before a later pane-close event must not be overwritten by that presentation event.

The automatic closure sequence is an invariant:

1. Observe an explicit finish request for the current task, or an explicit cancellation requiring closure.
2. Stop new admissions for the closing attachment and confirm relevant execution has settled or stopped.
3. Catch up and retain native history, exposed activity, task/run outcome, final or partial output, and delivery intent.
4. Confirm child-owned execution is stopped, except for explicitly handed-off persistent work.
5. Revalidate current attachment ownership, generation, visit/hold state, and navigation safety.
6. Close only that owned pane and record the acknowledgement or cleanup failure.
7. Keep the child and its history inspectable and explicitly resumable in the master.

Stop child-owned background execution before closure.
Intentionally persistent servers require an explicit acknowledged ownership handoff rather than becoming accidental orphans.
Never terminate pre-existing or shared processes through child cleanup.
Use structured interruption/shutdown and bounded supervision rather than synthetic Escape as proof that execution stopped.
If cleanup cannot establish stopped execution or safe attachment ownership, retain an attention-needed diagnostic and do not claim successful cancellation or cleanup.
Keep any surviving pane open rather than close a guessed target.
Honor Herdr protected-close failures instead of bypassing their guard.

Parent result consumption is not a prerequisite for pane closure.
Persisted delivery intent and recoverable history are prerequisites, because the master may be busy or offline.
Closure retries must be idempotent and must not target a moved, replaced, reopened, or repurposed attachment using stale identity.
Task outcome and cleanup outcome remain separately visible, so a successful task with failed cleanup is not confused with a failed task.

Approval trace: Q2, Q9, Q14, Q16, Q24, Q27, Q32, Q33.

## 7. Durable lifetime and result delivery

Unfinished native children survive master reload, exit, and crash.
Show the management connection as unavailable while preserving child execution and native interaction.
Reconnect only when the same validated master session returns, with one active management controller for that parent identity.
A different master session, guessed pane label, reused PID, or stale pane handle is insufficient authority.
Human continuations while disconnected still use the same durable admission authority and execution limit.
If that authority is unavailable, visibly queue or reject new execution rather than bypass the limit.

Persist sufficient association, identity, policy, event correlation, task/run receipts, and current attachment information to rebuild the dashboard and recover delivery.
Use owner-private storage and authenticated local control; keep credentials and private endpoint material out of argv, previews, and public repository evidence.
Native conversation history is authoritative for finalized conversation content, while a durable normalized journal/index captures transient activity, correlation, and management receipts.
Maintain one live Pi session writer and one exact managed Codex thread, including during reconnect and archive resume.
A resumed attachment gets a new generation and new task/run identities while preserving child/native conversation identity and origin.
Revalidate policy and trust without silently widening capabilities or replacing intended model/cwd settings with shell defaults.

Automatically notify the master for model-visible task completion, task failure, and needed guidance.
Private asides use the human-only delivery policy in section 8.
Keep all intermediate runs inspectable without automatically waking the master.
Preserve idle-delayed follow-up delivery and explicit-wait consumption for eligible notifications.
Key durable receipts by task/run identity, not only child ID, so later outcomes do not replace earlier pending outcomes.
Distinguish recorded outcome, pending delivery, native queue admission, observed parent insertion, and explicit-wait consumption.
Reconcile persisted receipts with parent-session history on recovery so acknowledged events are not lost or needlessly redelivered.
Duplicate transport/history observations must not create duplicate logical dashboard entries or notifications.
Do not claim crash-safe delivery merely because a frontend send call returned or a message was queued.

Approval trace: Q3, Q4, Q10, Q11, Q18, Q19, Q26.

## 8. Private asides and retained history

Inside Herdr, `/btw` uses native Pi panes, the same closure/hold behavior, and durable history while retaining its user-only origin.
Its result is available to the human without entering the master model's context or waking it.
Exclude private-aside content and metadata from model-facing child tools, including guessed-ID access, reconstructed archives, and replay.
Human continuation and resume must preserve the private origin.
Outside Herdr, preserve today's `/btw` compatibility behavior.

Retain all content actually exposed by the harness: user/controller messages, assistant text, exposed reasoning/redaction, tool arguments/results/errors, queues, model/effort changes, usage, lifecycle, and cleanup outcomes.
Do not claim to reconstruct hidden reasoning or recover payloads already truncated by the harness.
Use paged previews and bounded model/tool payloads while permitting fuller access to retained exposed data and available output artifacts.
Clearly mark source truncation, missing data, and unavailable reasoning.
Keep private parent-associated histories across reload/restart until explicitly deleted.
Bound memory, rendering, and indexing independently of retention; cache pruning must not terminate work or delete the durable archive.

Separate Forget from dashboard from Permanent deletion.
Forgetting an archived association does not by default delete native conversation files.
Permanent deletion is explicitly confirmed and limited to verified stopped, owned conversation/history artifacts.
Archive cleanup never deletes live work, project files, or worktrees.
Deleting an archive cannot promise to erase task results already recorded in the parent's conversation.

Approval trace: Q15, Q21, Q28, Q29.

## 9. Skill, prompt, and documentation integration

Update `home/.pi/agent/skills/subagents/SKILL.md` as a required part of implementation.
Its live Home Manager link resolves to this file.
The skill guides delegation and tool use; registration, launch, enforcement, and lifecycle belong to the extension.
Replace the blanket claim that every child is headless with the actual native-Herdr versus compatibility routing.
Document self-contained prompts, explicit context copying, master sends/steering, needs guidance, finish versus idle, waiting/cancellation, pane holds/resume, and automatic task-level notifications.
Keep existing model/harness routing and the Codex feature-only `/goal` policy intact.
Keep native interactive terminal children distinct from Codex Computer Use; a native pane does not add computer-use capabilities.

Update `home/.pi/agent/extensions/subagents/src/prompt.ts` and registered tool descriptions/schemas together with the skill.
The model-visible instructions must explain the actual mode, admission semantics, task completion, significant notification policy, and relevant controls without stale headless-only claims.
Revise extension-owned documentation that still describes stub backends or obsolete lifecycle semantics.
Add concise human-facing instructions for dashboard actions, Tab then Enter, native Escape, Keep open, privacy, archive access, and explicit resume.
Keep behavioral documentation pointed at authoritative implementations instead of copying speculative upstream claims.

Test actual emitted model prompts and effective child tools/commands, not only documentation string presence.
Exercise both native-Herdr and compatibility descriptions so skill instructions and registered tool behavior agree after reload.
The feature is incomplete if the extension works but the skill still teaches the old workflow.

Approval trace: Dmitri's explicit skill-update request, Q13, Q17, Q18, Q19, Q20, Q23, Q31, Q37.

## 10. Integration seams and implementation gates

Keep a small backend-neutral orchestration interface and normalized read projection for the master dashboard.
Separate conversation ownership, admitted execution, management connection, and terminal attachment lifetimes instead of overloading parent scope disposal.
Keep current scoped headless adapters on their compatibility path.
Use an interactive Pi child bridge, an exact-thread native Codex adapter, a Herdr presentation adapter, and durable admission/receipt ownership behind that interface.
Exact internal process topology, control schemas, storage layout, and timeout values are engineering choices constrained by the observable invariants above.

Static research supports an interactive Pi bridge and a private Unix app-server with native Codex remote attachment to the exact managed thread.
It does not prove current-version end-to-end behavior or all policy enforcement.
The hardest gates are Codex pre-start admission for human turns, native child restriction/session-switch enforcement, acknowledged finish/control operations, durable recovery, and safe shutdown of independently owned execution.
Herdr focus and close do not provide atomic conversation-ownership conditions, and focus-event observation is asynchronous.
Use serialization, fresh validation, controlled attachment lifetime, and conservative refusal when identity/visit state is uncertain.
If an invariant cannot be achieved safely through existing supported interfaces, stop and report the blocker rather than silently weaken it or patch Herdr.
Distinguish auxiliary Codex threads from the assigned conversation so unrelated naming work cannot become its activity/result authority.
Align extension development types with the installed runtime before claiming typechecked compatibility.

Approval trace: Q5, Q11, Q14, Q16, Q22, Q30, Q32, Q36.

## 11. Acceptance and rollout

Require isolated current-version feasibility proofs before changing the active extension.
Use owned disposable test sessions and isolated implementation paths rather than modifying existing user panes or the live out-of-store extension during a proof.
Historical experiments are references, not substitutes for these gates.
Only perform these future steps after explicit authorization.

### Required acceptance evidence

- Native Pi and Codex interfaces and master controls address the same verified conversation, including human-started turns and archive resume.
- Fresh self-contained tasks and explicit branch-aware copied context behave as documented without unintended conversation switches.
- Four-run admission holds across harnesses, concurrent starts, guidance responses, human continuations, reopened children, and offline operation.
- Waiting-to-start states execute no hidden model/tool work and preserve focus/zoom while capacity or readable space is unavailable.
- Structured sends distinguish queued follow-up, supported steering, admission, rejection, and observed execution.
- Finish differs from idle; late input revokes finish; queued work and cleanup cannot race into premature closure.
- Visits, direct Herdr entry, Keep open, failures, cancellation, and unsent-draft policy behave as documented.
- Completion racing with direct pane entry conservatively holds the native interface open when visit state is uncertain.
- Instructions after a retained terminal outcome create a new task without rewriting that outcome or allowing stale closure to stop the new work.
- Native Escape, Ctrl+], ordinary typing, Unicode, paste, terminal resize, and external-editor behavior remain correct.
- Physical Tab then Enter returns to the original validated master, restores presentation, and reports an unavailable master without redirecting to unrelated work.
- Multi-client ambiguity disables automatic focus changes rather than affecting another client.
- Master reload, orderly exit, crash, and same-session return preserve native child execution, admission, history, and recoverable notifications.
- Conversation history and outcomes are retained before safe automatic closure; child-owned execution stops or is explicitly handed off, without affecting shared processes.
- Manual close, moves, stale handles, replaced occupants, partial startup, protected-close rejection, bridge loss, and cleanup failure produce honest outcomes without stranded waits.
- Manual closure during active work recovers history through the last durable event and visibly marks an unconfirmed tail, rather than fabricating complete history.
- Recovery and duplicate event replay preserve distinct tasks/runs and do not overwrite pending outcomes or multiply notifications.
- `/subagents` remains granular and responsive with large histories, after closure and restart, without starting execution merely to inspect an archive.
- `/btw` remains user-only through guessed-ID access, model tools, human continuations, archive reconstruction, and result replay.
- Effective child capabilities retain permission/trust policy and prevent recursive delegation, direct question tools, and unmanaged conversation replacement after reload/resume.
- Ordinary-terminal headless and Claude compatibility behavior remain intact.
- Skill instructions, tool schemas/descriptions, emitted prompts, human instructions, and implementation behavior agree.
- Isolated end-user visual and physical-key testing meets the native UI standard, alongside deterministic lifecycle/race tests, typechecking, lint/format checks, and regression tests.

Deploy only after both native harnesses and all required safety/compatibility gates pass.
A failed or unproven gate is a blocker, not permission for hidden fallback or reduced policy enforcement.
No implementation, proof, deployment, commit, or push is authorized by this document alone.

Approval trace: Q36 and the preceding functional decisions.

## Research references

- [Upstream functionality and source study](../research/pi-interactive-subagents-reference.md).
- [Current installed Pi/Codex/Herdr capability assessment](../research/pi-herdr-interactive-current-capabilities.md).
- [Return shortcut and configuration evidence](../research/pi-herdr-return-shortcut.md).
- [Historical feasibility work](../research/pi-subagents-herdr-panes.md).
- [Settled agent capability policy](../agent-capability-policy.md).
