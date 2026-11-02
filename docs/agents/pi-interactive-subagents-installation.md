# Interactive Pi subagents installation candidate

Dotfiles owns the immutable Pi package selection and matching delegation skill.
The implementation repository is `dimajarkov/pi-interactive-subagents`; its canonical development checkout is `~/pi-interactive-subagents`.
That mutable checkout is not the installation source.

## Provisional nested-delegation candidate

`home/.pi/agent/settings.json` selects published revision `56ef9441059687651ca35340e7b633317afe8b4f` from [package draft PR #3](https://github.com/dimajarkov/pi-interactive-subagents/pull/3).
The prior selection is `116f5a611a879e99c65ddd61d527823e277c4d47`.
This candidate prepares [dotfiles #60](https://github.com/dimajarkov/dotfiles/issues/60), part of [spec #54](https://github.com/dimajarkov/dotfiles/issues/54).
It is provisional: [#59](https://github.com/dimajarkov/dotfiles/issues/59) still lacks native rendered acceptance because Computer Use refuses terminal apps.
Source review, native API/process/transcript checks and isolated installation do not establish rendered grouping, readability or physical keyboard behavior.
Keep #60 open and the integration PR draft until that gate and affected exact-revision checks are complete.
This is neither release readiness nor authorization to merge, switch Home Manager, reload active Pi or replace a Herdr server.

The package manifest loads the extension once, registering `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume` and the existing workflow commands.
The matching `home/.pi/agent/skills/subagents/SKILL.md` covers recursive and same-role tools, branch-column placement, autonomous waiting, immediate-parent outcomes, explicit denials, Alt+J and receipt-based recovery.
`home.nix` retains its existing out-of-store skill mapping.
Parent `openai-codex/gpt-6.1-sol` with **medium** thinking and all unrelated settings remain unchanged.
The old custom subagents, ask-user and built-in MCP extensions retain their exclusions.

`HazAT/pi-config@34829ad8053667e16b1288f9c1d24d8a300ec077` still selects only `extensions/todos/index.ts`, `skills/write-todos` and `skills/commit`, with empty prompts and themes.
Preserve every unrelated package pin, model filter, resource and software owner.

## Required Herdr candidate

The nested package requires Herdr source `e3a21bb0e8eded3c0b97b13083fc54f4c6ff7c6a`, published in [Herdr draft PR #2](https://github.com/dimajarkov/herdr/pull/2).
Its tree matches verified `5f5c12172bd14fd23772a588cb3e1eee5f08dc14` and includes prerequisite Ghostty fix `496acfe5978b12f27637c39821ce4145a474cfac`.
The tested candidate binary SHA-256 is `644119907d433f16ccad9a1ef7a6e631e8e6d1f44d3025fa31c80acc1a053798`.

In addition to managed job/control v1 and cooperative control, the target server must expose `terminal.job.branch_capabilities` and `terminal.job.launch_branch`.
The branch capability response and successful managed-job receipt retain version 1 shapes; a version string alone cannot prove branch compatibility.
The package performs capability and identity preflight before allocation, preserving zoom refusal and requiring at least 40 usable columns and 12 usable rows per affected pane.
Unsupported servers refuse without falling back to legacy splits.
The existing `Formula/herdr.rb` pin at `c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f` lacks the new branch methods and is deliberately unchanged by this provisional preparation.

After native acceptance and exact-head review, prepare a separately reviewed Homebrew formula revision with the accepted source, archive checksum, build identity and branch schema checks.
Follow [compatible Herdr installation](herdr-compatible-installation.md) for the existing package owner and guarded maintenance procedure.
Publish the formula before installation, preserve the old keg/receipt and native state, and restart only explicitly approved named servers.
Installing a CLI leaves already-running servers unchanged.
Validate the actual intended server's branch capability and a disposable public Pi launch before considering it compatible.

## Isolated installation, reload and rollback proof

`tests/fixtures/pi-herdr-installation.mjs` uses the **installed Pi 1.4.0** public resource loader, SDK sessions without hooks and normal package resolution.
Use `/nix/store/22d3lfn7mahhd8hfbxz430fdhp8c5hh6-pi-coding-agent-1.4.0/lib/pi-coding-agent/packages` for native provenance, not the fork's unit SDK 1.1 dependency.
The fixture compares the installed prior selection with the candidate, checks tools, bundled definitions, filtered skills, workflow prompts, command diagnostics and Alt+J without the former Ctrl+J/new-line collision.
The parent retains its unrelated tools; role SDK allowlists exclude unrelated browser tools and Claude.
No active visual host is supplied, so `codex_computer_use` remains unavailable and no visual proof is claimed.

```sh
PI_TEST_PACKAGES=/nix/store/22d3lfn7mahhd8hfbxz430fdhp8c5hh6-pi-coding-agent-1.4.0/lib/pi-coding-agent/packages \
PI_HERDR_FORK_SOURCE=/Users/dmitrijarkov/pi-interactive-subagents \
PI_HERDR_DEPENDENCY_SOURCE="$HOME/.pi/agent/git/github.com/HazAT/pi-config" \
PI_HERDR_NETWORK_INSTALL=1 \
node tests/fixtures/pi-herdr-installation.mjs
```

The default resource pass seeds private detached caches from verified local commits; `PI_HERDR_NETWORK_INSTALL=1` additionally performs fresh public Pi CLI installs into a separate private agent directory.
It verifies fetched heads before applying the reviewed filtered settings and guidance to the resource loader.
The CLI installs neither credentials nor native sessions.
The reload path clones installed npm/Git caches privately, preserving unrelated resources without writing to active caches.
It uses an empty private auth file, disables model network/refresh and never starts a model, session hooks, mux, browser or Computer Use.
Credential values are never read; the live credential identity and metadata remain unchanged.

Resource reload alone does not change an existing Git cache revision.
The fixture reinstalls the prior source through the public Pi CLI using the verified local source as its private cache origin, then restores the entire prior settings selection, the prior immutable cache head and the exact matching prior skill text from base `f50353be0e664f374e38f8fed95877cd1001bbe7`.
It compares registered resources after rollback and checks native history hashes, project sentinels, active settings and worktree identities, including missing registered paths.
Private inventories and evidence remain in the emitted owner-private temporary directory outside this public repository.
Review all diagnostics, including unchanged baseline warnings; resource checks do not substitute for #59 acceptance.

## Approved rollout and history-preserving rollback

After all acceptance and review gates pass on the exact published revisions, record the installation commit, prior package pin, matching guidance, intended Herdr server and pre-rollout Home Manager generation.
Active settings and the skill mapping are out-of-store links: moving this candidate into the dirty primary checkout could activate it before a rebuild.
Preserve unrelated primary changes and stop reload-capable Pi sessions before any separately approved transfer of the reviewed change.
Keep that boundary closed until the matching skill mapping and compatible server are available, then apply the reviewed generation through the existing `rebuild.sh` workflow and start fresh Pi deliberately.
No running conversation is upgraded merely by preparing or publishing this candidate.

For rollback, stop new delegation/reloads and revert only the installation commit with `git revert <installation-commit>` in the approved integration target.
Restore **both** `116f5a611a879e99c65ddd61d527823e277c4d47` and its matching prior guidance, preserving unrelated intervening changes, then apply the reviewed generation.
Before starting fresh Pi, explicitly run `pi install git:github.com/dimajarkov/pi-interactive-subagents@116f5a611a879e99c65ddd61d527823e277c4d47` in the approved agent directory and verify its cache HEAD; a reload alone is insufficient.
A separately changed Herdr installation uses its separately recorded Homebrew rollback and approved named-server restart boundary.
Retain native JSONL histories, policy/execution companions, delegation journals, lifecycle receipts, auth, project files, immutable caches, runtime data and canonical worktrees.
Rollback restores selection and guidance; it does not delete conversations or infer settlement of unresolved owned jobs.
