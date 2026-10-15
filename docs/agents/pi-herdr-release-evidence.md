# Interactive Pi subagents release evidence

This is the aggregate release-candidate record for [spec #36](https://github.com/dimajarkov/dotfiles/issues/36) and [ticket #45](https://github.com/dimajarkov/dotfiles/issues/45), updated on 2026-10-15.
It records accepted evidence and remaining gates; it does not authorize or establish active deployment.

## Immutable candidate

| Component | Exact revision or identity |
| --- | --- |
| Interactive Pi fork | `dimajarkov/pi-interactive-subagents@3e19238850aaf467d671957c7315c875ecf6b6e6` |
| Pinned upstream comparison | `HazAT/pi-interactive-subagents@c100577ebf7393a11d098ad9810ec6c269dcfc30` |
| Managed Herdr prerequisite | `dimajarkov/herdr@c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f` |
| Tested Herdr binary SHA-256 | `e3b917d4f939162b5ce8473716ea43872f35ff9d8399bdccda4f3f37ad083918` |
| Dotfiles installation candidate | Reviewed `ef404f1e691de32a8c2f5f21ec77a51d9b42501f`; merged on master as `f82a0f5d99be9d0861f673eb12744a8e208b159a` through PR #47 |
| Selected planning dependencies | `HazAT/pi-config@34829ad8053667e16b1288f9c1d24d8a300ec077` |
| Native Pi | Declared patched Pi 1.1.0, upstream `earendil-works/pi@abe508e1b89912adde45528136c3221eb69acdd7`, with dotfiles-owned message-admission and user-request-lifecycle patches |
| Dedicated native browser | Nix-owned Chrome for Testing 155.0.8059.79, declared by dotfiles `4622b988199676e1f1c827d25043bcb875f4b318` |

The dotfiles candidate installs the exact fork through Pi's existing package mechanism and selects only the todo extension, write-todos skill and commit skill from the planning-dependency revision.
The matching delegation skill and old-extension exclusions are part of the same candidate.
The source repositories and retained ticket worktrees remain separate from the installed package cache.
The merged PR #47 tree matches the reviewed installation plus initial evidence snapshot `6279b42f6b01c4d80a85826d055fa9fb8dc8af64`.
This final evidence follow-up starts from that merged master revision and does not change package pins or active settings.

## Acceptance matrix

These entries map to the ten criteria in #45.
Earlier accepted native runs retain their actual source snapshot; a later source review or deterministic test does not turn them into fresh executions of every final component.

| # | Status | Evidence and boundary |
| --- | --- | --- |
| 1 | Accepted | Final Pi source passes all 218 deterministic tests with zero failures or skips, strict TypeScript, Oxc lint and formatting checks. Actual installed patched Pi 1.1 declarations were checked separately from pinned npm aliases. Herdr passes its native pipeline: 3942 native tests, 13 existing default skips, 156 Python tests and 67 Bun tests. Live existing-backend gaps remain explicit below. |
| 2 | Accepted | Earlier accepted proofs cover concurrent children, context/customization/initial skills/nesting, help/resume, interruption, takeover/auto-exit, widgets and full-context iterate. The fresh final installed-resource workflow now completes native scout, interactive planner, unaided worker and independent reviewer phases, with all asynchronous results delivered. Root functional verification and independent whole-workflow audit pass; bounded cleanup checks confirm the exact private server stopped. |
| 3 | Accepted actual execution | Earlier and fresh final workflow native planner messages/tools establish exact `openai-codex/gpt-6-astra` at medium thinking. No model substitution was used. Final effective installed definitions preserve that default; a registry listing alone is not execution proof. |
| 4 | Accepted | Fresh final workflow native scout, worker and reviewer executions establish `openai-codex/gpt-6.1-sol` at medium thinking; the accepted browser run separately establishes the visual tester's Sol/medium execution. Final installed-resource reload verifies effective defaults and SDK tool allowlists. Independent whole-workflow audit accepts the native role evidence; the separate visual run is retained at its actual source snapshot. |
| 5 | Accepted | #41's actual Pi parent spawned the visual tester at fork `9e774c69d4081b67c834d7033be539a1b8417184`. The child requested native Computer Use, the active Codex host observed the exact owned Chrome for Testing fixture and clicked its counter from 0 to 1, and the child received an actual PNG plus provenance before independent parent result delivery and pane closure. |
| 6 | Accepted human substitution | The user explicitly accepted rendered terminal interaction, widgets, Ctrl+J/Ctrl+O, readable wrapping, Unicode, multiline paste, resizing and recovery keys. Terminal-app Computer Use is unavailable under the supported route; these are human observations, not automated terminal screenshots or physical-key injection. Native browser evidence remains separate. |
| 7 | Accepted | Native/backend safety evidence covers protected close, moved/released/restarted identities, independent children, no-sidecar exits, completion-sidecar races, original parent preservation and queued-before-same-PTY replacement. A disconnected operation remains outcome_unknown; the replacement receives no old input/correlation/native work, and stale cooperative prompt/abort refuse. Whole-job close owns that dedicated resource until explicit release. |
| 8 | Documented candidate | This record identifies source snapshots, evidence boundaries and known limitations. Installation, update and history-preserving rollback are documented separately. Exact-snapshot approval remains a separate release gate. |
| 9 | Binding release gate | Missing exact Astra execution or a missing/expired approved visual capability must block readiness. Existing unavailable-model and stale/absent-host checks fail explicitly; no weaker model, CLI metadata or role name substitutes for the required capability. |
| 10 | Boundary maintained | No active Pi/Herdr deployment, installed Herdr replacement, live-server restart or Home Manager switch was performed by this candidate. Ticket acceptance and draft PRs do not authorize deployment. |

## Installation and regression evidence

[#43](https://github.com/dimajarkov/dotfiles/issues/43) is closed with all seven criteria accepted within its explicit available-backend and honest-coverage boundary.
All four original backends and explicit selection remain implemented.
Public executable-boundary regressions cover their selection and refusal behavior, and the final deterministic command includes every deterministic test file.
The two original upstream surface/lifecycle files self-skipped before registering real cases in the unavailable environments; their file-container results are not counted as live passes.

A newly owned private WezTerm 20240203-110809-5046fc22 server establishes actual launch/targeting, synchronous/asynchronous reads, long-command completion, interruption with the same child/editor retained, fresh-child help, exact-session resume, independent parent result and owned cleanup.
Trailing empty viewport rows initially concealed a completion marker.
A failing public regression preceded the WezTerm-only trailing-padding normalization, and the real-server rerun returned the marker with exit zero while retaining interior content.
The regression sessions used OpenAI Sol at medium thinking, without Anthropic execution.

[#44](https://github.com/dimajarkov/dotfiles/issues/44) is closed with all eight criteria accepted at the installation candidate above.
A separate fresh private installation through the existing Pi CLI fetched both exact immutable repositories without seeded-cache fallback.
Reviewed filtered settings and the matching skill were applied before loading resources.
The installed Pi 1.1 resource loader verified tool/command/shortcut registrations, workflow prompts, effective role definitions and SDK specialist tool allowlists, then restored the baseline through a separate rollback reload.
The proofs preserved native history, credential contents/pointers, active settings, project files, source-worktree identities, unrelated resources and parent Sol/xhigh defaults.
Nix parsing, the actual home.file skill mapping, skill validation, fixture syntax and diff checks passed.
These installation checks did not start models or session-start hooks.

## Fresh final installed workflow

The fresh synthetic `/plan` proof uses the final immutable Pi fork and reviewed dotfiles installation settings, matching delegation skill and filtered planning resources in a private configuration.
Its parent runs the real Pi RPC interface; its children are actual interactive native Pi sessions in managed Herdr panes.
It establishes workflow and native request delivery, not a new rendered terminal or physical-key acceptance run.

The native sequence is scout Sol/medium, interactive Astra/medium planner, worker Sol/medium and independent reviewer Sol/medium.
The host supplied reviewed answers during the interactive planning phases and reminded the planner to invoke its required completion tool.
After the planner's independently delivered completion, the parent legitimately resumed that same finished planner to align the plan with the task's stop-on-failure requirement.
That adjustment did not resume a failed worker or transfer worker ownership to the parent.

The default worker itself retrieved the unclaimed todo, claimed it under its actual native session identity, appended evidence and closed it after implementation.
It ran the unmodified baseline suite successfully with 1/1 tests, implemented exact primitive-empty-string handling, and passed the expanded 12/12 regression suite.
Its scoped synthetic-project commit is `c7d061629d74c8907b5b8139d6bef948efd1ce93`, containing only the intended implementation and tests.
The independent reviewer approved with no findings, and the parent verified all todos closed before executing the unchanged fixed functional checker.
Root independently reran that checker and received its expected passing marker.
The parent performed no implementation edits, worker todo ownership mutation or worker-resume workaround.

The fixed checker had failed before the change with exit 1 on the actual empty-string behavior, then passed afterward.
This is independent fail-before/pass-after functional evidence; the worker did not perform or claim a deliberately failing red-test stage.
All child results arrived independently at the parent with exit zero.
The original parent terminal condition and focus remained identical, only the parent pane remained at the final audit boundary, and the original parent process was alive there.

Two interim 30-second cooperative-control outcomes were initially unknown; later queries of those exact same operations genuinely settled.
The final explicit completion operation remained outcome_unknown when its wrapper exited.
Its matching native request ended interrupted after actual subagent_done and deliberate shutdown, not completed or settled.
Actual subagent_done invocation/result, child exit zero and independently delivered parent result establish child completion for that last case, not a completed native turn or settled control receipt.
The named proof server stop returned exit zero, the socket was absent and status reported not running.
Its frontend nevertheless exited 1 with no pending frontend or timeout; the enclosing proof wrapper exited zero.
The final exact process check found no candidate/fixture/session survivors, and the original parent process had exited after the cleanup boundary.
Cleanup is not represented as every component exiting zero.
Independent read-only whole-workflow audit supports acceptance; cleanup checks are limited to the named proof server and exact proof-owned processes.

## Known limitations and failed cases

- cmux, tmux and zellij were unavailable on PATH and in the checked standard locations.
  Their live coverage remains skipped/unverified.
  The inherited upstream harness omits WezTerm discovery and has incomplete focus helpers; no GUI focus or pixel claim is inferred from the private WezTerm terminal proof.
- The interrupted WezTerm child's subsequent help-request turn failed with a generic Codex processing error and exhausted native retries before caller_ping ran.
  No fork root cause was established.
  Successful fresh-child help/resume is separate evidence and does not repair that failed conversation.
- The earlier full planning pipeline required parent-assisted todo claim/resume and remains historical evidence only.
  The fresh final workflow above establishes unaided worker ownership separately; its interactive planner guidance and legitimate completed-planner revision remain explicit.
- Browser acceptance covers the dedicated Chrome for Testing route, not stable Chrome or Zen.
  The route requires an explicitly active Codex host with ordinary native permissions; queue coordination does not grant unattended Computer Use capability.
- Browser paste produced no text and direct native typing dropped Unicode characters in the separate selection experiment.
  Those limitations are not waived by accepted terminal Unicode/paste observations.
  The synthetic browser fixture also had a minor counter/draft spacing issue.
- Pi resized the returned PNG from 2400x1812 to 2000x1510.
  The delivered tool image is an actual screenshot, but its bytes are not identical to the original capture.
- The browser proof wrapper ended with a frontend wait/termination timeout and exit 1.
  The exact private-server stop passed, and subsequent process/socket checks established eventual teardown; the whole wrapper is not recorded as exit zero.
- Managed cooperative control and process identity proof are qualified on native macOS.
  Windows cross-lint was unavailable without the pre-existing required SDK setup; no SDK/license installation was performed.
  Managed pane closure hangs up the exact owned PTY resource and does not promise a PID sweep or forced termination of detached or HUP-ignoring descendants.
- The upstream child Ctrl+J widget shortcut deliberately overrides Pi's tui.input.newLine binding.
  There are no new parent command/shortcut conflicts; eight pre-existing unrelated Infisical skill-description warnings remain visible.

## Evidence locations and release boundary

Public implementation details and accepted history live in the fork's `docs/herdr-*.md` files at the exact candidate revision, particularly its browser, lifecycle, customization, failure-safety and upstream-compatibility records.
GitHub tickets #37 through #44 and #46 retain their accepted criteria and checkpoint notes.
Full native transcripts, model messages, screenshots, resource inventories and process receipts stay in owner-private evidence directories and are not published here.
This summary does not contain credentials, personal browser data or full native transcripts.

Independent final Standards and Spec source review found zero actionable findings at Pi `3e192388`, Herdr `c8d5b8f0` and dotfiles installation `ef404f1e` against their recorded bases.
That review did not itself execute tests or establish visual acceptance, and this later documentation record requires its own snapshot refresh.
The fresh full workflow now has successful native evidence, independent functional verification and independent read-only whole-workflow audit acceptance.
The current human Plannotator outcomes for the Pi and Herdr PRs were dismissed, not approved.
Exact-current-base/head approval remains a separate readiness gate; the user-merged dotfiles PR #47 does not supply that approval or authorize deployment.
Until required acceptance and review gates complete, this record does not claim release readiness.

Use the [installation and rollback procedure](pi-interactive-subagents-installation.md) for deliberate immutable updates and any separately authorized rollout.
Rollback changes resource selection while retaining native conversations, credentials, source repositories and worktrees.
Do not deploy, delete caches/history or retire retained worktrees merely because this documentation or a ticket is accepted.
