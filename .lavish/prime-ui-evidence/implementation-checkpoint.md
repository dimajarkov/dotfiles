# Prime UI implementation checkpoint

Date: 2026-08-13
Branch: `feature/prime-ui`
Base: `origin/master` at `6d202fa`

## Confirmed scope

The final `#contract` in `.lavish/prime-agent-ui-scope-grill.html` is authoritative.
The implementation is extension-only against public Pi 0.84.1 APIs.
It must preserve Pi-native assistant streaming, Ctrl+T reasoning, global Ctrl+O expansion, exceptional loaders, custom/MCP tool ownership, `prime-parity.ts`, and terminal title behavior.

## Baseline evidence

Real WezTerm inline evidence was captured before editing under `.lavish/prime-ui-evidence/before/`.
The complete tool run shows the current multi-line read, write, edit, bash, grep, find, and ls presentation.
The startup capture shows the current custom footer omits the Supabase extension status even though `supabase-keychain/index.ts` sets it.

## Public API findings used for implementation

- Pi exposes exact public built-in factories for all seven tools.
- `pi.getAllTools()` exposes canonical `sourceInfo`; only entries whose winning source is `builtin` may be replaced.
- A same-name registration replaces execution as well as rendering, so the extension must spread the exact factory-produced definition and replace only render slots.
- Renderer context provides stable `toolCallId`, row-local state, component reuse, expansion, partial/error state, and invalidation.
- Pi owns Ctrl+O, Ctrl+T, assistant streaming, retries, and compaction.
- `setWorkingIndicator()` safely customizes only the normal loader.
- Footer data exposes a live extension-status map and a branch-change subscription.
- Renderer components have no disposal hook, so all timers and invalidators must be centrally owned by the extension and cleared on completion and session shutdown.

## Smallest complete architecture

1. Expand `prime-style.ts` into the sole owner of fixed Prime theme selection, editor surface, seven guarded built-in renderers, shared activity lifecycle, normal working line, and responsive footer.
2. Use one shared 250 ms pulse/timer per session rather than per-row timers.
3. Register renderer-bearing definitions only for winning built-ins whose `sourceInfo.source` is exactly `builtin`.
4. Reuse each public factory definition unchanged except `renderShell`, `renderCall`, and `renderResult`.
5. Keep successful tools to one content row, show five wrapped rows for live bash and failures, and expose retained content only under native expansion.
6. Remove standalone footer and macOS theme ownership from Home Manager while retaining alternate theme files.
7. Add focused behavioral tests with Node's built-in test runner through Bun, requiring no new dependency or package-manager configuration.
8. Validate, commit coherent milestones, capture real inline/fullscreen after evidence, then stop at Lavish human visual approval without deploying Home Manager.

## Honest extension-only constraints

- Historical restored rows cannot show measured durations because Pi does not persist tool timestamps; duration is omitted rather than fabricated.
- Strictly removing Pi's inter-tool spacer is not possible from a renderer; the successful tool content itself is one physical row.
- Public APIs cannot guarantee a dynamically registered same-name tool that appears after session startup will reclaim ownership.
- Exact viewport and flicker behavior remains a real-terminal acceptance check because transcript internals are private.
