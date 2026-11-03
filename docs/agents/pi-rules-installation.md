# Pi path-scoped rules

Pi remains owned by the existing Nix `pi-coding-agent` package.
Home Manager installs the rules extension at `~/.pi/agent/packages/pi-claude-rules`, and Pi loads that local package through `home/.pi/agent/settings.json`.
`nix/packages/pi-claude-rules.nix` pins the exact published `@jordyvanvorselen/pi-claude-rules` 0.1.3 archive by hash.
This avoids adding a package to Pi's shared npm prefix, which can reconcile unrelated cached dependencies during installation.

## Local changes to the reviewed upstream

The runtime-only npm manifest and generated lock live under `nix/packages/pi-claude-rules/`.
They omit development tools and host-provided Pi peers, pin YAML 2.9.1, and use minimatch 11.0.1, which fixes [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
The upstream matcher used default optimization level 1, so the advisory's level-2 amplification was not reachable through its reviewed configuration; the package nevertheless avoids shipping the affected version.

`nix/patches/pi-claude-rules-resume.patch` fixes retained multiline-rule detection after resume and compaction.
Upstream searches JSON-serialized messages for an unescaped rule body, which misses newlines, quotes, and backslashes and injects an already retained rule again.
The patch compares actual model-visible text blocks instead.
The lifecycle fixture reproduces the failure on unpatched 0.1.3 and passes against the built patched output.
Keep that regression when updating the archive, patch, runtime lock, and `npmDepsHash` together.
The upstream source and license are retained in the built package.

## Configuration and scope

`home/.pi/agent/claude-rules.json` is the canonical configuration, linked by Home Manager to `~/.pi/agent/claude-rules.json`.
It adds project `.agents/rules` and user `~/.agents/rules` to the extension's existing `.claude/rules` discovery.
Extra-directory paths and their globs are relative to Pi's working directory, so launch Pi at the repository root for repository-level `.agents/rules`.
Unlike its built-in `.claude/rules` sources, extra `.agents/rules` sources do not automatically walk ancestor directories.
Do not copy the same rules into both directory families; author each fact once.

For example, a repository can create `.agents/rules/billing.md`:

```markdown
---
paths:
  - "packages/billing/**"
---

Read `docs/product/billing.md` before changing billing behavior.
The product document owns the business rules; do not duplicate them here.
```

Hybrid mode keeps unscoped and always-apply bodies in the system prompt and delivers scoped bodies through matching `read` results.
A direct `edit` or `write` is blocked before mutation until its rule has crossed the next model-context boundary; the model can then retry.
This also protects a read and edit emitted in the same tool batch.
Failed reads and prospective new file paths still deliver their matching guidance.

Only the named `read`, `edit`, and `write` tools activate scoped rules in this configuration.
Shell commands, other custom tool names, and search tools do not implicitly activate them.
`bashActivation` stays disabled because arbitrary shell-command target detection is incomplete.
Rules are instructions, not an authorization boundary or filesystem sandbox.
Project `.pi/claude-rules.json` can override extension settings, and upstream loads rule files and that configuration independently of Pi's native project-resource trust decision.
Only use rule/configuration sources you trust; symlinked rule files and directories are followed.
Planning before file access still needs the root `AGENTS.md` task router or an explicit rule read.

Run `/claude-rules` to inspect discovery and scopes, `/claude-rules <name>` to read a rule, and `/claude-rules-reload` after editing rules or extension settings.
The startup summary and activation entries are rendered by the upstream extension, not by a custom presentation layer.
No existing Arena or Carbon documentation is moved by this installation, and no global rule bodies are invented.

## Verification

Build only the extension from a reviewed checkout:

```sh
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-rules-proof.XXXXXX")"
nix build --out-link "$proof_dir/package" \
  'path:.#darwinConfigurations.mac.config.home-manager.users.dmitrijarkov.home.file.".pi/agent/packages/pi-claude-rules".source'
```

The flake also exposes `packages.aarch64-darwin.pi-claude-rules` and an offline native lifecycle/lint gate:

```sh
nix build --no-link path:.#checks.aarch64-darwin.pi-rules
```

For focused checks outside the Nix sandbox, export `PI_TEST_PACKAGES` as the existing installed Pi runtime's `lib/pi-coding-agent/packages` directory, then run:

```sh
PI_RULES_PACKAGE_DIR="$proof_dir/package" node tests/fixtures/pi-rules-installation.mjs
PI_RULES_PACKAGE_DIR="$proof_dir/package" node tests/fixtures/pi-rules-resources.mjs
nix flake check --no-build path:.
```

The lifecycle fixture uses real Pi sessions, persisted history, compaction, model-request context, and filesystem tools with a deterministic offline provider replacing only the external model.
It proves rule delivery and mutation timing, not a live model's semantic obedience or terminal rendering.
It covers unrelated paths, project/user discovery, Claude compatibility, failed reads, read-then-edit, blocked edit/write and retry, same-batch safety, multiline resume deduplication, compaction reinjection, and slash reload.
The macOS resource fixture APFS-clones installed caches, loads the declared local package alongside existing resources, compares tool and command registration, and verifies rollback and unchanged live settings, credential bytes, and npm manifests.
It does not run session-start hooks or contact a model/provider.

## Narrow activation and rollback

Do not run a broad Darwin/Home Manager switch just for this feature; the repository's intentional Homebrew `zap` cleanup is unrelated rollout risk.
Normal future Home Manager generations own both new targets through `home.nix`.
For a feature-only initial activation, retain Nix GC roots for the extension source and configuration-link source under a private `~/.local/state/pi-rules/generations/<installation-commit>/` directory.
Build the two `.source` attributes with `nix build --out-link` there and verify the resolved extension output and the configuration link's exact `~/.dotfiles/home/.pi/agent/claude-rules.json` target.
The out-of-store configuration target must exist in the canonical dotfiles checkout when settings are activated.

Create only previously absent `~/.pi/agent/packages/pi-claude-rules` and `~/.pi/agent/claude-rules.json` symlinks to those verified store outputs.
Refuse existing destinations instead of overwriting them, and verify parent paths are the intended user's directories.
Prepare the package and configuration links before landing the settings declaration so a new Pi process cannot see a declared but missing package.
After integration, verify a fresh Pi resource load resolves the Nix package once and exposes both commands.
Start a fresh Pi session or use `/reload` in an idle existing session to activate it there; never reload an actively executing conversation from an unrelated process.

Rollback reverts the installation commit and removes only the two feature-created links after confirming their exact targets and that no active session still depends on them.
Retain the rooted Nix outputs until those sessions have exited or reloaded without the extension.
Do not remove shared npm modules, credentials, native history, other extensions, or unrelated configuration.
