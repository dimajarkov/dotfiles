# Pi and Codex Herdr return shortcut

Checked 2026-10-10 against installed Herdr 0.9.3, Pi 1.1.0, and Codex CLI 0.160.1.
`HERDR_ENV=1` was verified before CLI discovery.
Evidence comprises static help, default config, protocol-22 schema, installed Pi files, and tagged source fetched through `gh-axi`.
No session inventory, transcripts, focus changes, agents, or configuration changes were performed.

## Recommendation and key conflicts

Recommend `prefix+enter`, meaning **Tab then Enter** with the user's current prefix.
It is unoccupied in the [actual config](../../home/.config/herdr/config.toml), Herdr's installed default config, and the [0.9.3 prefix dispatcher](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/input.rs#L564).
Herdr [parses `enter` and `return` identically](https://github.com/herdrdev/herdr/blob/v0.9.3/src/config/keybinds.rs#L1305), so use canonical `enter` in config.
Enter already confirms a workspace in Herdr's separate Navigate mode, so this recommendation applies to normal pane terminal mode.

| Candidate | Existing use or constraint |
| --- | --- |
| Tab then Enter | Free for a custom return command in normal prefix mode |
| Tab then `]` | Also free in the inspected terminal prefix bindings, a possible fallback |
| Tab then `r` | Occupied by default resize mode |
| Tab then `o` | Occupied by the user's `annotate.open` command |
| Tab then Tab | Sends a native Tab through the prefix escape mechanism |
| Raw Ctrl+] | Occupied in Pi and Codex, with additional possible editor conflicts |

Installed Pi [TUI defaults](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/tui/dist/keybindings.js:37) bind Ctrl+] to `tui.editor.jumpForward`, Tab to completion, and Enter to submission.
Its [application defaults](/nix/store/bd072d1v031ny5jjw4r9byiq6n6hrr6v-pi-coding-agent-1.1.0/lib/pi-coding-agent/packages/coding-agent/dist/core/keybindings.js:28) bind Escape to interrupt and Ctrl+G to the external editor, with none of these replaced by [user overrides](/Users/dmitrijarkov/.pi/agent/keybindings.json).
Codex 0.160.1 [defaults](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/tui/src/keymap.rs#L1643) use Escape to interrupt, Ctrl+G for the external editor, Enter to submit, Tab to queue, and Ctrl+] to skip a question.
The inspected `~/.codex/config.toml` contains no keymap overrides, while child invocation or project overrides remain unverified.
[Official OpenAI documentation](https://learn.chatgpt.com/docs/cli-customization) also confirms Ctrl+G editor entry.
Keep native Escape and raw Ctrl+] intact, including editor uses such as Vim tag navigation.

## Existing Herdr mechanism

Herdr already supports `[[keys.command]]` with `type = "shell"`, launching a detached background command without creating a pane or sending input to the child.
The [client dispatcher](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/input.rs#L564) consumes the prefix and matching command before forwarding terminal input, so the mechanism works independently of Pi, Codex, or an editor running inside that pane.
This is cross-application support within Herdr, with no guarantee for Herdr modal surfaces or a GUI application outside its terminal.

The client [supplies its projected workspace, tab, and pane](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/actions.rs#L246), and the server [validates and selects that target](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/custom_commands.rs#L135) before launching the command.
The helper receives `HERDR_ACTIVE_WORKSPACE_ID`, `HERDR_ACTIVE_TAB_ID`, `HERDR_ACTIVE_PANE_ID`, optional `HERDR_ACTIVE_PANE_CWD`, `HERDR_SOCKET_PATH`, and `HERDR_BIN_PATH` from [the command environment](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/custom_commands.rs#L244).
They identify the invoking pane and endpoint but supply no native conversation identity, attachment generation, original parent, or client ID.
The socket path supplies exact session routing, and an explicit `--session` overrides it according to [session selection](https://github.com/herdrdev/herdr/blob/v0.9.3/src/session.rs#L173).
Helper stdout and stderr are discarded, so return failures need a deliberate visible reporting path.

## Exact parent, focus, and visits

The installed schema exposes exact socket method `pane.focus` with only `pane_id`, while CLI `pane focus` is directional and `agent focus` accepts a live agent name or agent pane.
The [exact handler](https://github.com/herdrdev/herdr/blob/v0.9.3/src/app/api/panes.rs#L484) selects across tabs and workspaces, marks the target seen, and returns pane information or `pane_not_found`.
It does not validate the original parent conversation or restore the prior zoom presentation.
Public socket focus [projects the selected target to all attached shell clients](https://github.com/herdrdev/herdr/blob/v0.9.3/src/server/headless/client_views.rs#L809), with no public initiating-client selector.
Single-client scope is therefore the reliable initial contract for this helper route.

Retain the original parent association by fixed native conversation identity and validated terminal attachment, resolving current handles after either pane moves.
[Pane information](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/panes.rs#L449) includes terminal and reported agent-session identity, while [move events](https://github.com/herdrdev/herdr/blob/v0.9.3/src/api/schema/events.rs#L507) include previous handles and the new pane information.
Neither an upward neighbor nor [last-pane history](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/actions.rs#L1080) guarantees return to that original parent.
Because focus accepts only a pane handle, validation and focus have no atomic conversation-ownership condition.

[Mouse entry](https://github.com/herdrdev/herdr/blob/v0.9.3/src/client/shell/mouse.rs#L2198) requests pane focus, and [changed client focus](https://github.com/herdrdev/herdr/blob/v0.9.3/src/server/headless/client_views.rs#L946) emits subscribable `pane.focused` events.
A controller can observe direct entry, hold managed launches, zoom the child, and restore captured presentation on return without a Herdr patch.
This is an asynchronous reaction, not an atomic hold before the first click, keystroke, or concurrent split.
Focus event payloads contain pane and workspace IDs but no client ID, initiating actor, durable sequence, or visit token, and unchanged pane focus need not emit another entry event.

## Configuration boundary and remaining uncertainty

Existing Herdr functionality needs no source patch for the recommended return mechanism.
The minimal declarative change would be one shell-command binding for `prefix+enter` in [the repository-owned config](../../home/.config/herdr/config.toml), which is the resolved target of `~/.config/herdr/config.toml` through [Home Manager](../../home.nix:467).
A helper and controller still need identity lookup, holds, zoom restoration, and failure reporting.
That config scope remains a spec decision, and no binding or helper was implemented here.

If Herdr config changes are excluded, a controlling PTY wrapper could intercept a dedicated key across foreground pane applications.
An app-local shortcut alone cannot cover an independently running editor, and a PTY wrapper adds terminal protocol and key-forwarding obligations.
A Herdr source patch for stronger client targeting or atomic visits remains outside the approved scope.
Physical-key behavior, modal precedence, observer races, reconnect recovery, and exact zoom restoration require later authorized validation.
