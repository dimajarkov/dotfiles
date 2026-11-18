# Project notes for agents

Deliberate decisions in this repo - do NOT silently revert them:

- `homebrew.onActivation.cleanup = "zap"` in `configuration.nix` is intentional. It forces the good habit of declaring every Homebrew package in the Nix config instead of installing things ad-hoc, which keeps the machine reproducible. Do not soften it to `uninstall` or `none`. Users are warned about its effect in README.md; this note is for anyone tempted to change the setting itself.
- Never commit `.no-mistakes/` validation evidence to this public repo. `.no-mistakes/` is gitignored; if a validation pipeline stages evidence into a branch, drop it before merging.

## Commands requiring authentication

When a command needs a password, sudo authentication, an interactive login, MFA, or browser/device authorization, run it in a dedicated Herdr pane so the user can complete authentication directly.

- Check `HERDR_ENV=1` and read the `herdr` skill before controlling panes; use the installed CLI help for current syntax.
- Create a sibling shell pane in the current tab and working directory, with `--no-focus`; use the pane ID returned by Herdr for all subsequent commands.
- Run the intended command there and tell the user which pane to open, what command is running, and what authentication step needs their attention.
- Let the user enter secrets and approve authentication themselves.
  Never request credentials in chat, send them through tool calls, or capture or repeat passwords, tokens, MFA codes, or recovery codes.
- Keep the original command running while the user authenticates; inspect its non-sensitive result and exit status before continuing.
  Authentication success alone does not prove the command succeeded, and authentication does not authorize unrelated privileged actions.
- If Herdr is unavailable, explain the limitation and give the user the exact command and working directory to run manually; resume after they provide a non-sensitive result.

## Agent skills

### Issue tracker

For ticket operations, follow `docs/agents/issue-tracker.md`.

### Triage labels

Use the label vocabulary in `docs/agents/triage-labels.md`.

### Domain docs

Follow the single-context documentation rules in `docs/agents/domain.md`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
