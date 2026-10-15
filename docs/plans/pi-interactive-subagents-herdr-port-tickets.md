# Herdr upstream subagents port: published tickets

Dmitri approved this nine-slice breakdown.
The source specification is [GitHub issue #36](https://github.com/dimajarkov/dotfiles/issues/36), with its local copy in [the port specification](pi-interactive-subagents-herdr-port-spec.md).
Each ticket has `ticket` and `ready-for-agent` labels and is a native child of #36.
The blocking relationships below are GitHub native dependencies, independently of that hierarchy.
Published issue bodies, labels, hierarchy, and dependencies were read back and verified.
The source spec's body, state, and labels remain unchanged.
Historical custom-subagent tickets were not modified.

## Published issue index

| Slice | Ticket | Blocked by |
| --- | --- | --- |
| 1 | [#37: First working Herdr child](https://github.com/dimajarkov/dotfiles/issues/37) | None |
| 2 | [#38: Interactive child lifecycle](https://github.com/dimajarkov/dotfiles/issues/38) | #37 |
| 3 | [#39: Customization and live supervision](https://github.com/dimajarkov/dotfiles/issues/39) | #37 |
| 4 | [#40: OpenAI specialists and upstream workflows](https://github.com/dimajarkov/dotfiles/issues/40) | #38, #39 |
| 5 | [#41: Approved visual-tester route](https://github.com/dimajarkov/dotfiles/issues/41) | #37 |
| 6 | [#42: Failure-safe Herdr operation](https://github.com/dimajarkov/dotfiles/issues/42) | #38 |
| 7 | [#43: Existing multiplexer regression parity](https://github.com/dimajarkov/dotfiles/issues/43) | #40, #41, #42 |
| 8 | [#44: Declarative installation and accurate delegation instructions](https://github.com/dimajarkov/dotfiles/issues/44) | #40, #41, #42 |
| 9 | [#45: End-user acceptance and release readiness](https://github.com/dimajarkov/dotfiles/issues/45) | #43, #44 |

## Execution and release gates

Work the frontier: only start a ticket after its native blocking tickets are complete and implementation is authorized.
The initial frontier is #37.
Exact `openai-codex/gpt-6-astra` availability and a verified approved Computer Use route for the Pi visual tester remain explicit release gates.
The model configuration slice can verify unavailable-model errors without substituting a model; full release acceptance cannot waive the requested planner's availability.
Ticket publication does not authorize implementation, fork creation, live proofs, active deployment, commits, or pushes.
