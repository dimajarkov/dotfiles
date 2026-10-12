# Hunk turn-review finalization, 2026-10-12

The feature is implemented, locally committed, transferred to primary `master`, and installed for fresh Git-checkout Pi/Codex sessions in compatible Herdr 0.9.3 or newer.
The installed service is healthy and fresh login-shell routing selects the Nix feature profile.
Production native Codex hook trust, credential-injected TUI/listener acceptance, and rendered terminal/key approval remain human steps.
Existing sessions do not acquire the new capabilities retroactively, and the protected `handovers` 0.9.1 server remains incompatible.

## Authorization, identity, and transfer

The complete V2 authorization matched dotfiles HEAD `64b1bb942aab321f8c09bfb60f36b90c4d770f4e`, all 93 changed paths, and fingerprint `74045ced9ac73684d5d4b56f76a77f65ee3b32b0909e7672d1f885b45011a173` before feature mutations.
Both durable leases matched their canonical checkout paths and jobs: dotfiles slot 13 `hunk-turn-review`, and Hunk slot 1 `hunk-turn-review-host`.
The Hunk source remains clean at `7924812b0bd95c5d72749bc9777b1b47e2123b3a`; no additional source commit was needed.
The official `nix/runtime/generate-hunk-review-patch.py` generator reproduced the unchanged patch SHA-256 `c6143d1c8a076fd622181fc7cb2c991dd1ed9b9759d362faf398706d774bce2c` and exact provenance.
No generated file or changelog was manually edited.

The local 93-path feature commit was `efcd3c0f25f7ca717b645e0ced940e6529042835`.
Rebasing onto the latest primary `34635ec3bfdfe9394a728d4956f6c0012a308f8d` produced `fe21f6a1f3f3fbebe2a366771080e3b37ad21be1`, followed by a guarded primary fast-forward.
There were no content conflicts or overlap with primary's unrelated paths.
Transient Git index locks interrupted the initial commit and rebase attempts; the locks disappeared without removal, and the recorded rebase continued normally.
Dotfiles had no executable commit hooks to bypass.
The earlier source commit skipped its auto-stashing lint-staged hook under the preservation contract after equivalent explicit declared checks; that exception remains recorded honestly.
Commit messages contain no agent co-author trailers.
No GitHub operation, push, stash, reset, clean, or worktree return occurred.

Fresh manifests and copies preserved all 15 unrelated primary paths, including untracked `.lavish` artifacts and Hunk configuration edits, plus staged/unstaged binary diffs and modes.
The first transfer preserved their bytes and staged state exactly.
A subsequent concurrent edit to `tests/browser-policy.py` was captured in a newer private preservation receipt rather than overwritten to match the old one.
Documentation follow-up uses only these feature-owned evidence files and another preservation-guarded fast-forward.

## Exact transferred artifact

The transferred primary source built `/nix/store/f9r36kbxbb5s0myp7sbi9yrm6z00i889-hunk-turn-review-profile-1.0.0`.
Its NAR hash is `sha256-qdNEa/9KLuK0JyLQJBhKTuZm7n5zuyQYAS3HAiea1WE=`.
The private output link is `hunk-session-recovery-iete88yk/deployment.1sjzlxun/roots/transferred-profile`.
The reviewed repair artifact `/nix/store/cqra6c74xz47xgdlcn8jlbfpzj65jnpr-hunk-turn-review-profile-1.0.0` remains rooted at `/private/tmp/hunk-bash-repair-hx0gli5g/roots/profile`.
The old blocked `n82...` artifact is historical evidence only.

All 28 packaged Hunk/Pi/Codex/UI/client assets match the reviewed repair artifact byte-for-byte.
All nine packaged runtime modules match the freshly compiled source bytes.
Packaged provenance matches the committed Hunk source and repository provenance exactly.
The official packaged host-type generator reproduces declaration SHA-256 `5707a22c3a539058e3b9523ebc2e036cf1cca355c65a83ab11ea9d329fda1383`.
All eight feature wrappers match after normalizing only declared Nix store references and select `/nix/store/wd2ys7yi9ns7fwvlrkq3mgimi2j69da4-bash-5.3p16/bin/bash`.
The installed interactive Bash is `/nix/store/42qfy5a6fhfa3fk2krvpx1ifzw5kb4wm-bash-interactive-5.3p16/bin/bash`.
API 29, checkpoint v1, session wire revision 17, and Herdr protocol 22 remain unchanged.

The authorized Darwin recipe repair preserves Nix ownership, the original tarball and patches 001-009, downstream patches, options, compiler flags, hardening, and output layout while adding hash-pinned GNU patches 010-016.
It uses Dash only for the POSIX configure step and repaired noninteractive Bash for feature builds.
Both Home Manager branches declare one Bash provider; old installations remain retained.
No compatibility-mode workaround, `/bin/bash` substitution, generated Herdr helper rewrite, broad rebuild, or Homebrew cleanup was used.
See [Bash diagnosis and source proof](hunk-bash-heredoc-diagnosis.md).

## Validation

The independent Standards and Spec rereviews cleared every identified product finding.
Separate sa-35 Standards and sa-36 Spec reviews reported zero findings on the exact 13-file Bash repair delta, including upstream hashes and unchanged assets.
The watch-test correction uses the real controller refresh seam without changing product watch code.
The final clean Hunk source has 4,570 regular tests passing, 53 expected optional/platform skips, and zero failures.
Its complete PTY suite passed 213 cases with 831 assertions; the watch suite passed 99 cases with four unchanged conditional skips.
Source TypeScript, Oxfmt, dependency boundaries, generated documentation checks, npm build, packed consumers, and explicit Oxlint coverage of 1,093 Git-owned JS/TS paths passed.
Existing React `act(...)` diagnostics remain unsuppressed.

| Reviewed repaired `cqra...` validation                                                  | Result                  |
| --------------------------------------------------------------------------------------- | ----------------------- |
| Heredoc regression, including dynamic fallback under the current 512-byte pipe capacity | 48 pass                 |
| Core/native                                                                             | 31 pass, 284 assertions |
| UI with matching source host                                                            | 40 pass, 259 assertions |
| SDK/Codex with older-host refusal fixtures                                              | 29 pass, 335 assertions |
| Native isolated installer                                                               | 29 pass, no skips       |
| Agent-skill migration                                                                   | 26 pass                 |
| Runtime build, core/UI types, launcher, Oxc, Ruff, whitespace                           | Pass                    |

The final transferred `f9r36...` profile passed all eight newly rooted Nix checks and the whole-flake check.
Those checks include the source recipe, both Home Manager branches, heredoc/dynamic regressions, packaged host/artifact/launcher, and isolated installer.
Its read-only installer plan passed against the exact approved live acceptance socket before activation.
All four actual native synthetic workflows were repeated against this exact final profile:

| Workflow                    | Result | Private fixture evidence   |
| --------------------------- | ------ | -------------------------- |
| Codex direct tab/checkpoint | Pass   | `/private/tmp/htrl-AawBk0` |
| Codex complete default      | Pass   | `/private/tmp/htrl-HFMNHa` |
| Pi direct tab/checkpoint    | Pass   | `/private/tmp/htrl-K6sCGn` |
| Pi complete default         | Pass   | `/private/tmp/htrl-TW87Gg` |

Each command is `HERDR_ENV=1 bun tests/hunk-turn-review-live.ts --profile /nix/store/f9r36kbxbb5s0myp7sbi9yrm6z00i889-hunk-turn-review-profile-1.0.0 --kind KIND`, adding `--case tab-checkpoint` only for direct handoff.
Fixtures use private homes/checkouts, real native harnesses, and deterministic responses at the external model seam.
Codex uses only the existing credential-free `/opt/homebrew/bin/codex app-server` branch, with no copied authentication or personal agent account startup.
Each fixture retains its exact server/child cleanup receipt without stopping an existing server.
These results establish the automated integration layer, not production hook trust or rendered approval.

## Installed state and preservation

Feature-only `plan` and `activate` targeted `/Users/dmitrijarkov/.config/herdr/sessions/hunk-turn-review-acceptance/herdr.sock`, the approved existing 0.9.3/protocol 22 server, PID 58878.
Port 47658 was free and bindable before activation; no listener was terminated.
Activation succeeded and the installer reports `installed`, `healthy-at-installation`, and pending native workflow acceptance.
Launchd `gui/501/dev.dmitri.hunk-turn-review` is running PID 18183 with the exact packaged runtime and matching plist/manifest.
A fresh version-1 `review.status` request without an invented native session returned the expected `REFUSED` acknowledgement on the owner-private mode-0600 socket.
The live profile link, transaction `bc62de1aef754981a13a6b7239788b0f`, private backup, and generation GC root all identify the exact installed artifact.
Durable reviews, notes, pending batches, journals, and logs remain retained outside Git checkouts.

Fresh `/bin/zsh -lic` shells resolve Bash, Hunk, Pi, Codex, and the control CLI through `~/.local/state/hunk-turn-review/profile/bin`; Herdr still resolves through `/opt/homebrew/bin/herdr`.
The observed versions are Bash `5.3.16(1)-release`, Hunk `0.23.0`, Pi `1.1.0`, and Herdr CLI `0.9.3`.
The read-only one-bin audit confirms exact canonical Nix paths and intentionally reports retained duplicate installations with exit 1.
Control CLI help passes without creating or adopting a production session.
The existing `/opt/homebrew/bin/codex` credential-injection entrypoint and npm delegate `0.162.1` are preserved; neither ordinary Codex `--help` nor `--version` was invoked.
Codex `config.toml` is byte-unchanged, and native trust was not modified or bypassed.

Four installed asset links are globally discoverable.
Existing Codex hook groups, Herdr plugin entries, and shell content remain intact with additive feature integration.
The original `handovers` server remains 0.9.1/protocol 22 with all 52 original pane IDs, and the acceptance server retains its original pane.
The manual Hunk broker remains PID 22746 on port 47657; the feature host has a separate runtime/config namespace and broker port 47658.
No live feature review host was opened solely to verify installation.
Original agents, manual windows, old installations, and both durable leases remain retained.

## Remaining human acceptance

Open a fresh shell and approve the exact installed hook definitions through native Codex `/hooks`.
Then start fresh Git-checkout Pi and credential-injected Codex sessions inside the compatible acceptance server and confirm first-edit placement, preserved focus, response review, explicit feedback delivery, and terminal appearance/key behavior.
Production TUI/listener acceptance and native hook approval remain unverified.
Computer Use denial for WezTerm was not bypassed, and protocol/PTY results are not pixel approval.
The protected original 0.9.1 session was not upgraded or restarted.
Do not return dotfiles slot 13 or Hunk slot 1 until the user explicitly declares each job finished.

Private command arrays, build/check/native logs, component hashes, preservation copies, installed status, launchd/process proofs, fresh-shell audits, and generation identity remain under `/var/folders/dh/8gfrsysn4jj6_8s6s5cn69940000gn/T/hunk-session-recovery-iete88yk/deployment.1sjzlxun`.
Earlier source/package receipts remain under `finalization._ltroqfj`, and repair receipts remain under `/private/tmp/hunk-bash-repair-hx0gli5g`.
