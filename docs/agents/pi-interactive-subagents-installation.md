# Interactive Pi subagents installation candidate

The implementation repository is `dimajarkov/pi-interactive-subagents`; dotfiles owns its declarative installation and matching delegation skill.
The canonical development checkout is `~/pi-interactive-subagents`, with ticket worktrees kept separately.
Production settings select an immutable Git revision, not that mutable checkout.
This document describes a candidate and its validation procedure, not an active deployment.

## Declared resources

`home/.pi/agent/settings.json` declares the fork at `116f5a611a879e99c65ddd61d527823e277c4d47` through Pi's existing `packages` mechanism.
The package's own manifest loads its extension once.
The same settings select only `extensions/todos/index.ts`, `skills/write-todos` and `skills/commit` from `HazAT/pi-config@34829ad8053667e16b1288f9c1d24d8a300ec077`.
Those are paths relative to that repository's root; a private proof's `config/` destination is not a package resource prefix.
The package filter excludes its other extensions, prompts and themes and does not install its personal global settings or models.

`home.nix` maps the matching `home/.pi/agent/skills/subagents` through the existing out-of-store file mechanism.
Pi settings enable that rewritten skill while retaining the negative exclusions for the previous custom subagents extension, legacy ask-user extension and built-in MCP extension.
The replacement registers upstream `subagent`, `subagent_interrupt`, `subagent_resume` and `subagents_list` tools and `/subagent`, `/iterate` and `/plan` commands.
It does not introduce the old headless tool aliases or a custom dashboard.
Parent `openai-codex/gpt-6.1-sol`, `xhigh`, enabled model filtering and unrelated resource declarations remain unchanged.

## Isolated verification

`tests/fixtures/pi-herdr-installation.mjs` uses the installed Pi 1.1 public resource loader, package-source resolver and extension registration surfaces.
It imports the actual installed npm extensions along with the candidate, checks registered tools, commands, shortcut diagnostics, selected skills, effective bundled definitions and emitted workflow prompts, then reloads the baseline settings to verify rollback.
It never calls session-start hooks, launches a model, starts a multiplexer, opens a browser or switches Home Manager.
The installed npm cache is cloned into the private fixture directory rather than exposed as a writable shared prefix.
Credentials remain an unchanged pointer to the existing approved file; the proof never copies their contents.
Native history and project sentinels, original native history contents, active settings and credential hashes are checked across the candidate and rollback.
Private inventories and diagnostics remain outside this public repository.

Run the fixture from the isolated dotfiles candidate, supplying the existing Nix Pi runtime's packages directory and verified immutable local source checkouts:

```sh
PI_TEST_PACKAGES=<existing-pi-store-path>/lib/pi-coding-agent/packages \
PI_HERDR_FORK_SOURCE=<verified-fork-checkout> \
PI_HERDR_DEPENDENCY_SOURCE=<verified-HazAT-pi-config-checkout> \
node tests/fixtures/pi-herdr-installation.mjs
```

Each source checkout must contain the exact declared commit.
The fixture seeds detached private Git caches at those commits and uses normal Pi package filtering with network disabled; no global install or package-manager migration occurs.
The resource fixture establishes installed-resource reload and rollback, not model execution or GUI behavior.
A separate fresh network-install proof on 2026-10-15 ran the existing Pi CLI's `install` command for each published immutable package in a new owner-private agent directory.
Both commands succeeded, and the resulting Git cache heads matched the exact fork and HazAT commits declared above.
The reviewed filtered settings and matching subagents skill were applied there before any resource loading.
That fresh proof created no auth file, copied no credentials, started no model or resource hooks and left active settings unchanged.
It establishes the declared package-fetch/install path independently of the offline-seeded resource fixture.
Review the emitted private report for every load error, command conflict and shortcut warning, including pre-existing diagnostics, before rollout.
A new duplicate tool name or shadowed workflow command must be resolved explicitly, not hidden by registration order.
The inspected installed resources emit eight pre-existing Infisical skill description-length warnings; the candidate preserves and reports them.
The child completion extension is also reloaded alongside the installed resources.
Its upstream `Ctrl+J` widget toggle deliberately overrides Pi's native `tui.input.newLine` shortcut in child sessions; the SDK reports this exact conflict and the fixture retains it.
The candidate adds no parent shortcut or command conflicts and does not change the parent's keybindings to conceal the child override.
Existing `browser_*` tools remain registered as unrelated installed resources.
SDK sessions built without starting hooks verify the scout/reviewer, worker and visual-tester allowlists exclude those tools, while the parent retains its existing tools.
Without an active visual-host capability, the resource-only visual-tester has read/write and control tools but lacks `codex_computer_use`; this is recorded as unavailable capability, not a successful visual route.

## Deliberate update and rollout

Fetch upstream in the separate fork, inspect the baseline diff, merge the port's integration branch deliberately and complete the issue acceptance and exact-head review checkpoints.
Record the accepted full fork SHA in the package declaration and update this document in the same installation change.
Keep the HazAT planning-resource SHA fixed unless its selected resources are intentionally reviewed and tested too.
Repeat the isolated reload, conflict check and rollback checks against the final declared SHAs.
Publish the exact fork revision before asking another machine to fetch it through Pi.
For a fresh isolated network-install check after the fork SHA is published, use the existing Pi binary with a separate private agent directory:

```sh
candidate_agent_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-herdr-network-install.XXXXXX")"
PI_CODING_AGENT_DIR="$candidate_agent_dir" pi install git:github.com/dimajarkov/pi-interactive-subagents@116f5a611a879e99c65ddd61d527823e277c4d47
PI_CODING_AGENT_DIR="$candidate_agent_dir" pi install git:github.com/HazAT/pi-config@34829ad8053667e16b1288f9c1d24d8a300ec077
```

These package commands install only into that private agent directory and do not launch a model.
Before loading resources or starting Pi there, replace the generated unfiltered package entries with the reviewed candidate settings and matching skill mapping.
In particular, apply the selected HazAT resource filter; merely installing that repository does not activate the reviewed restricted resource set.
Do not use `pi update` as a substitute for changing the reviewed immutable pin.

The Herdr deployment prerequisite is the managed conditional API implementation at exact source revision `c8d5b8f0d1b0ab9c7e98d05b1ed5b9606f87599f`.
Its tested candidate binary SHA-256 is `e3b917d4f939162b5ce8473716ea43872f35ff9d8399bdccda4f3f37ad083918`.
A public `0.9.3` or `0.9.4` version string alone does not establish those APIs; verify the actual managed capability preflight against the intended server.
The reproducible Homebrew declaration and one-time transition are documented in [compatible Herdr installation](herdr-compatible-installation.md).
Activating that package and restarting affected servers require separately approved deployment work.
This installation candidate does not replace the installed Homebrew owner or live Herdr servers.

Before active rollout, ticket #45 must verify all release gates against the final installation revision, including actual requested Astra execution and the approved visual route.
Source listings, model availability, a capability lease and this resource-only fixture do not independently satisfy those gates.
The current manual/native evidence and remaining upstream limitations belong to the implementation repository's `docs/herdr-*.md` evidence documents and the linked GitHub tickets.

The active settings are already an out-of-store link, while an older installation may still have the previous skill in a Home Manager store link.
After explicit rollout approval, stop Pi sessions that could reload these settings before checking the installation change into the live dotfiles checkout.
Keep that reload boundary closed until the Home Manager generation installs the matching skill mapping; start fresh Pi only afterward.
Apply the reviewed generation through the repository's existing `darwin-rebuild switch --flake ~/.dotfiles#mac` workflow.
Never check the candidate into the active checkout merely to inspect it.
This ticket does not run that switch or authorize a later rollout by itself.

## Rollback without deleting conversations

Record the installation commit or commits and the pre-rollout Home Manager generation before an approved switch.
Stop Pi reloads, revert only those installation commits in dotfiles with `git revert <installation-commit>` and apply the resulting reviewed configuration through the same existing rebuild workflow.
If a later installation-pin commit is separate, revert it first, then the installation commit; preserve any unrelated intervening dotfiles changes.
Verify the package entries and matching skill returned together before starting a fresh Pi session.
The older custom extension remains excluded after rollback, matching the pre-install baseline.

Rollback changes resource selection, not native session storage.
Leave `~/.pi/agent/sessions`, credentials, project files, canonical source repositories, ticket worktrees and private evidence in place.
Retained immutable package caches may stay on disk while their settings entries are absent.
Do not uninstall a shared package, delete a cache, rewrite history or prune worktrees as part of this rollback.

## Watcher lifecycle correction

The installed package pin above includes instance-owned observer state and cancellation provenance receipts.
A native Pi session replacement previously left a module-level observer signal aborted, so later launches acknowledged and immediately cancelled before creating child history.
The fix gives each registration independent watcher, timer and registry state and starts a fresh observer after session shutdown/start.
Observer shutdown retains its exact child job rather than treating it as an intentional stop request; the launch acknowledgement exposes a private lifecycle receipt path for recovery.

The package's `docs/watcher-lifecycle.md` describes ownership and recovery, and its opt-in `test/integration/herdr-session-boundary.test.ts` verifies one and four parallel real scouts after native session replacements.
The private native acceptance retained the active global resource selection, installed an immutable Git package through Pi, and verified five real Sol/medium findings, four simultaneously observed panes, result delivery, cleanup and preserved focus.
The matching delegation skill now requires agents to stop retries after shared immediate infrastructure failures and report delegation blocked instead of substituting local findings.
Deployment must reload the affected idle Pi conversation without clearing its native history; restarting the compatible Herdr server is unnecessary.
