# Hunk turn-review finalization, 2026-10-12

The authorized source-only Bash maintenance is complete, and the repaired rooted profile passes native Codex and Pi direct/default acceptance.
The Bash blocker below is historical; `/nix/store/n82xhvx6js7khjf4f1rspgkm81yasraj-hunk-turn-review-profile-1.0.0` is retained for comparison and is not the repaired artifact.
The resumed V2 authorization covers the remaining local dotfiles commit, preservation-safe primary transfer, and feature-only activation.
Before those mutations, the complete 93-path inventory matched fingerprint `74045ced9ac73684d5d4b56f76a77f65ee3b32b0909e7672d1f885b45011a173`, both durable leases matched their jobs and canonical checkout paths, and Hunk was committed clean at `7924812b0bd95c5d72749bc9777b1b47e2123b3a`.
Fresh private copies preserve all 15 unrelated primary paths, staged and unstaged binary diffs, untracked files, shell/config bytes, and server inventories.
The official snapshot generator reproduced the unchanged `c6143d1c8a076fd622181fc7cb2c991dd1ed9b9759d362faf398706d774bce2c` patch before committing.
The older authorization hashes and pre-repair blocker below are historical records.
The current deployment receipt is retained under `hunk-session-recovery-iete88yk/deployment.1sjzlxun`.
No native production trust approval or rendered acceptance is claimed.

## Focused Bash maintenance result

The new profile is `/nix/store/cqra6c74xz47xgdlcn8jlbfpzj65jnpr-hunk-turn-review-profile-1.0.0`, rooted at `/private/tmp/hunk-bash-repair-hx0gli5g/roots/profile`.
Its NAR hash is `sha256-Qx//0LQoSMnn8s0kAC5qEYb9DuTcevr2yl7bTtXmAek=`.
It selects Nix Bash `5.3.16(1)-release`, with hash-pinned official GNU patches 010-016 added to the original 5.3p9 recipe.
The source recipe, seven exact patch hashes, build-only Dash configure route, interactive/noninteractive paths, and rollback duplicates are documented in [Bash diagnosis and repair](hunk-bash-heredoc-diagnosis.md).
Home Manager evaluates one Bash provider with or without the feature profile, and all eight profile Bash wrappers select repaired noninteractive Bash.

Both production-candidate variants pass 32 heredoc cases, and the test-only build retaining the old 65,536-byte capacity assumption passes 16 more.
Fresh pipes still accept only 512 bytes, so the dynamic fallback is exercised under the original resource constraint.
The unchanged generated Codex helper reports the exact captured UUID/pane through repaired Bash.
Its SHA-256 remains `38a90a2a99872d06dcbc978e7613406cdd852dbb07503abd7a113f518d5951f3`.
The synthetic homes model the installer's PATH hook after system zshenv; no helper rewrite, auth copy, compatibility mode, or production trust change is used.

| Current repaired-profile validation                                                          | Result                  |
| -------------------------------------------------------------------------------------------- | ----------------------- |
| Core/native suite                                                                            | 31 pass, 284 assertions |
| UI with the unchanged matching source Hunk host                                              | 40 pass, 259 assertions |
| SDK/Codex including retained older-host refusal cases                                        | 29 pass, 335 assertions |
| Isolated real-profile installer including native old/current Herdr and fresh Bash precedence | 29 pass, no skips       |
| Agent-skill migration                                                                        | 26 pass                 |
| Rooted Nix checks and whole-flake check                                                      | All eight pass          |
| Source recipe and both Home Manager package branches                                         | Pass                    |
| Runtime build, core/UI TypeScript, launcher, Oxc, Ruff, whitespace                           | Pass                    |

The migration test initially referenced a garbage-collected Python output from its locked alternate package set.
Only its declared Python/Bash test dependencies were rebuilt and rooted; no machine profile or package-manager state changed.
Early fixture runs without the installed PATH hook selected p9; a private core home additionally needed byte-identical generated Pi/Codex integration helpers.
Those setup failures are retained as diagnostics and contribute no passing proof.
The final runs above use the correct profile, private home, matching Pi packages, matching Hunk source, and every optional native fixture input.

| Current native workflow     | Result | Private evidence           |
| --------------------------- | ------ | -------------------------- |
| Codex direct tab/checkpoint | Pass   | `/private/tmp/htrl-2Rd3nc` |
| Codex complete default      | Pass   | `/private/tmp/htrl-Pd38By` |
| Pi direct tab/checkpoint    | Pass   | `/private/tmp/htrl-uVCY5C` |
| Pi complete default         | Pass   | `/private/tmp/htrl-PfJ2Xr` |

Each native command uses `HERDR_ENV=1 bun tests/hunk-turn-review-live.ts --profile /nix/store/cqra6c74xz47xgdlcn8jlbfpzj65jnpr-hunk-turn-review-profile-1.0.0 --kind KIND`, with `--case tab-checkpoint` added only for direct handoff.
Codex invokes only the existing `/opt/homebrew/bin/codex app-server` branch through the declared feature wrapper.
The four fixture roots and cleanup receipts are retained; each owned server exits without stopping a pre-existing server.

The Hunk source remains clean at `7924812b0bd95c5d72749bc9777b1b47e2123b3a`.
The host patch SHA-256 remains `c6143d1c8a076fd622181fc7cb2c991dd1ed9b9759d362faf398706d774bce2c`, with matching source/package provenance.
All nine packaged runtime modules match the tested compiled source, and 28 packaged Hunk/Pi/Codex/UI/client assets match the prior profile byte-for-byte.
Only the generated plugin's declared wrapper reference differs in that asset comparison.
API 29, checkpoint v1, wire revision 17, and Herdr protocol 22 are unchanged.

Read-only installer planning passes against the existing acceptance socket.
The original handovers server remains 0.9.1 with its 52 pane IDs; acceptance remains 0.9.3 with PID 58878.
The acceptance server already had one pane at this maintenance inspection, unlike the earlier zero-pane receipt, and that pane is preserved.
The 15-path primary preservation receipt contains five newer browser-related edits; both the older receipt and current copies are retained without overwriting those edits.
Both leases remain held, all global Bash routes and old installations are retained, and no feature staging, commit, transfer, global PATH write, production activation, native trust change, or container operation occurred.

Private Bash repair receipts and all current check logs are under `/private/tmp/hunk-bash-repair-hx0gli5g`.
The parent can continue finalization from this exact rooted profile under its own remaining authority.
Production native `/hooks` approval, activation/runtime acceptance, and direct rendered terminal/key approval remain separate human or parent steps.
WezTerm Computer Use denial was not bypassed.

## Pre-repair source and package record

The approved gate matched both repository HEADs, changed-path inventories, and fingerprints before any finalization mutation.
Dotfiles matched `64b1bb942aab321f8c09bfb60f36b90c4d770f4e`, 87 changed paths, and fingerprint `ce3d5d58722e9ede6399aa441bd15e4e9bad76fe998f89ddf8db6bf6f85ca28a`.
Hunk matched `7991d3034af1d2116e9c77db31265e409a73bd9f`, 66 changed paths, and fingerprint `2401a0413fe7996d3e74db96ca0c3cc7dc17335b5026265e5670817ee863ffe5`.

The local Hunk commit is `7924812b0bd95c5d72749bc9777b1b47e2123b3a`, titled `feat(review): persist native human checkpoints and guard reloads`, without co-author trailers.
The source checkout is clean.
Its default lint-staged hook was skipped because it automatically stashes, which conflicts with the preservation contract; explicit declared Oxc and all other recorded source checks passed before committing.
Only source verification documentation changed after the frozen source checks.

`python3 nix/runtime/generate-hunk-review-patch.py /Users/dmitrijarkov/.treehouse/hunk-8e8c02/1/hunk` regenerated the patch and provenance after that source commit.
The patch SHA-256 is `c6143d1c8a076fd622181fc7cb2c991dd1ed9b9759d362faf398706d774bce2c`.
Packaged provenance names the exact source commit and matches the repository provenance byte-for-byte.
The generator's fixed `sourceState: review-required-snapshot` label is retained; the separate review results below record the completed review authority.

The retained pre-repair profile is `/nix/store/n82xhvx6js7khjf4f1rspgkm81yasraj-hunk-turn-review-profile-1.0.0`.
Its root is `/var/folders/dh/8gfrsysn4jj6_8s6s5cn69940000gn/T/hunk-session-recovery-iete88yk/finalization._ltroqfj/profile`.
Its NAR hash is `sha256-xBSnOzOvjA9EFkUOTCUdPbOFXElbuTfz+qcDmrC1Z6k=`.
All nine compiled runtime modules, source Pi/Codex adapters, public client, and shipped UI TypeScript files match the tested source bytes.
The official packaged host-type generator reproduces the UI declaration bytes exactly.
API 29, checkpoint schema 1, session wire 17, and the declared source/runtime toolchain locks remain unchanged.

## Fresh checks

| Check                                                                 | Result                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Source regular suite, declared Bun 1.4.2 and private cache            | 4,570 pass, 53 expected skips, 0 failures                                        |
| Source watch suite                                                    | 99 pass, four unchanged platform skips                                           |
| Controller and mounted AppHost lifetime tests                         | 39 pass, 164 assertions                                                          |
| Complete source PTY suite                                             | 213 pass, 831 assertions                                                         |
| Source review conformance and real Node broker                        | 125 conformance and four broker cases pass                                       |
| Source TypeScript, Oxfmt, dependency boundaries, generated-doc checks | Pass                                                                             |
| Explicit source JS/TS Oxlint inventory                                | 1,093 files, 0 warnings or errors                                                |
| Source npm build and packed consumers                                 | Pass; 37-file package, 38 documentation examples, NodeNext and bundler consumers |
| Rooted feature build and whole-flake check                            | Pass                                                                             |
| Core/native suite with canonical packaged runtime                     | 30 pass, one Herdr/Codex registration failure described below                    |
| UI suite with the matching actual source host                         | 40 pass, 259 assertions                                                          |
| Root Pi SDK/Codex suite                                               | 29 pass, 339 assertions                                                          |
| Packaged Pi lifecycle and admission checks                            | 16 and 13 pass                                                                   |
| Real-profile isolated installer cases                                 | All 29 pass                                                                      |
| Skill migration checks                                                | All 26 pass                                                                      |
| Launcher, host/artifact checks, core/UI types, Ruff, whitespace       | Pass                                                                             |

The first core invocation supplied a profile symlink as the Node entrypoint and exited before serving.
The corrected invocation uses the canonical packaged `runtime.js` path, matching the actual wrapper and all nine compared modules.
That initial orchestration failure is retained separately and contributes no passing proof.
Existing React `act(...)` diagnostic noise remains visible and unsuppressed.

Standards: the parent's independent final rereviews cleared the identified correctness and hard standards findings, including the test-helper naming correction.
Spec: the independent final rereviews cleared the baseline, restoration, cancellation, writer-scope, fallback, retention, recovery, and shutdown findings.
The approved gate records zero new defects on each axis.
The subsequent changes are evidence/README updates and official patch regeneration, without new product changes.

## Pre-repair native proof and blocker

The unchanged public fixture uses private HOME/XDG/runtime directories, fabricated checkouts, exact owned Herdr sessions, and deterministic responses only at the external model seam.
Codex fixtures invoke only `/opt/homebrew/bin/codex app-server`, with no copied authentication.
Neither its ordinary credential helper nor its `--version` branch is invoked.
Fixture hook trust applies only to those synthetic threads.

| Native workflow                     | Current result                                                 | Private evidence           |
| ----------------------------------- | -------------------------------------------------------------- | -------------------------- |
| Pi direct tab/checkpoint handoff    | Pass                                                           | `/private/tmp/htrl-83Iodl` |
| Pi complete default workflow        | Pass                                                           | `/private/tmp/htrl-Xz4HyF` |
| Codex direct tab/checkpoint handoff | Fails before placement: original Herdr native identity missing | `/private/tmp/htrl-kM5qQw` |
| Codex complete default workflow     | Not run while the first-placement prerequisite is blocked      | Pending                    |

The passing Pi runs retain the original native identity, native note editing/save, tab adoption, crash restoration, and explicit feedback processing.
Their exact profile roots remain retained, and cleanup receipts report no remaining owned processes.
The Codex failure safely retains the original session and warns rather than opening against an unverified replacement.
Its native hooks observe the actual request, but the generated Herdr SessionStart helper never reports that UUID to Herdr.

A private instrumented diagnostic verified the correct synthetic Herdr socket and pane variables.
Replaying the generated helper outside Codex reproduces the same stall before any registration request.
The selected route resolves `bash` to `/nix/store/72yw9glj9rk3xwymwwp965869gn6k3dz-bash-interactive-5.3p9/bin/bash`.
Its trace reports `cannot create temp file for here-document: No space left on device`, despite 34 GiB available on the backing filesystem.
Minimal here-documents of 512, 1,024, 2,048, and 4,096 bytes also stall on that route; 64 bytes completes.
The same generated helper through `/bin/bash` completes and sends the correct private `pane.report_agent_session` request.
This counterfactual is diagnostic evidence, not permission to rewrite generated hooks, migrate Bash, or substitute it silently in final native acceptance.
The underlying Bash/system-resource cause was unresolved at that point; the focused repair above resolves the Bash algorithm defect.

Recovery requires restoring healthy here-document execution on the declared Bash route, or separately authorizing and verifying a focused repair of that route.
Afterward rerun the canonical core suite and the unchanged direct/default Codex fixtures against this rooted profile before continuing finalization.

The blocked public command, from leased dotfiles slot 13, is:

```sh
HERDR_ENV=1 bun tests/hunk-turn-review-live.ts \
  --profile /nix/store/n82xhvx6js7khjf4f1rspgkm81yasraj-hunk-turn-review-profile-1.0.0 \
  --kind codex --case tab-checkpoint
```

It returns `review opens during actual native first response timed out` while the runtime retains `Original native session is missing or ambiguous in Herdr`.
After that prerequisite passes, run the same command without `--case tab-checkpoint` for the complete default workflow.
No original Herdr server, Hunk daemon, window, pane, or agent was stopped, upgraded, focused, or closed to obtain this evidence.

## Installation and preservation

The exact profile's read-only `plan` passes against `/Users/dmitrijarkov/.config/herdr/sessions/hunk-turn-review-acceptance/herdr.sock`, server 0.9.3/protocol 22.
The original `handovers` server remains 0.9.1/protocol 22.
Port 47658 has no observed listener, and no production activation has occurred.
The primary checkout remains on its existing `master`; no feature staging, commit, rebase, or transfer occurred there.
The preservation receipt captured the original ten unrelated paths plus two newer browser edits without overwriting any of them.
The final receipt captures 15 unrelated primary paths, including subsequent browser edits, and retains both earlier and newer copies.
All 52 original `handovers` pane IDs remain present; the acceptance server still has zero panes and the same PID 58878 identity.
The existing Codex credential-injection entrypoint, old installations, toolchain locks, and both durable Treehouse leases are retained.
Fresh login-shell resolution still selects the existing Hunk/Pi/Codex/Herdr routes because activation is pending.

After the blocker clears, commit the dotfiles feature, rebase onto the latest primary `master`, and fast-forward only after capturing and preserving any newer unrelated changes.
Repeat the transferred build/check and compare exact compiled bytes before the feature-only `activate` command.
Native Codex `/hooks` approval of the exact installed commands, production TUI/listener acceptance, and direct rendered terminal/key confirmation remain human steps.
WezTerm Computer Use denial has not been bypassed.

Private receipts, command arrays, terminal logs, source manifests, server inventories, preservation copies, and diagnostic traces remain under `hunk-session-recovery-iete88yk/finalization._ltroqfj`.
Important records are `source-results.json`, `source-package-results.json`, `nix-results.json`, `package-independent-results.json`, `component-proof.json`, `compiled-modules-proof.json`, `shell-counterfactual.json`, and `heredoc-size-matrix.json`.
Keep both leased worktrees and every live proof root until explicit job completion approval.
