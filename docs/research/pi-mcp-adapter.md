# Pi MCP adapter status-menu research

Research was completed on 2026-09-22 against the installed Pi 0.87.0 runtime, installed `pi-mcp-adapter` 2.11.0 package, official npm metadata, immutable upstream source tags, and the current dotfiles checkout.

## Conclusion

Installed `pi-mcp-adapter` 2.11.0 already provides an interactive server panel through `/mcp`, and `/mcp status` follows the same panel path in an interactive session.
The panel lists configured servers, cached tools, connection state, OAuth state, and direct-versus-proxy selections, but it is a management panel rather than a read-only status menu.
The package does not register `Ctrl+M` or any other global shortcut, does not publish a public runtime-status event, does not offer a footer-disable setting, and does not expose a supported hook for adding a Supabase PAT annotation to its panel.
Pi 0.87.0 can register a `Ctrl+M` shortcut and can either dispatch `/mcp` or render a new overlay, but dispatching `/mcp` cannot add PAT state to the adapter-owned panel.
Adapter 2.13.0 added the public `pi-mcp-adapter/status/v1` event, and adapter 2.17.0 added `settings.mcpFooterStatus` with `full`, `compact`, and `off` values.
The recommended design is therefore a small read-only local overlay driven by the newer public status event and the existing sanitized Supabase PAT readiness state, while retaining `/mcp` for management operations.
`Ctrl+M` has an input-encoding risk because legacy terminal input represents both Ctrl+M and Enter as carriage return, so the actual Ghostty and tmux route must prove that the two keys remain distinct before that shortcut is accepted.

## Installed package and runtime provenance

[`home/.pi/agent/settings.json`](../../home/.pi/agent/settings.json#L47-L52) declares the exact Pi package specifier `npm:pi-mcp-adapter@2.11.0`.
The Pi-owned install at `~/.pi/agent/npm/node_modules/pi-mcp-adapter/package.json` is version 2.11.0 and is the extension copy loaded for that package declaration.
A second version 2.11.0 copy supplies the globally installed CLI at `~/.npm-global/lib/node_modules/pi-mcp-adapter`, but that global CLI is not the package location selected by Pi's settings entry.
The Pi package lock resolves `pi-mcp-adapter` 2.11.0 from `https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-2.11.0.tgz` with integrity `sha512-4Y/eLbhbxnRih519dJUxMyQ5QASvPcdWyBlS8+dDXteAzaMuLnd4nMTWgoZw3JRIW+0r93KAQcz1Rbli4xCwEQ==`.
The [official npm metadata](https://registry.npmjs.org/pi-mcp-adapter/2.11.0) identifies Nico Bailon as author, MIT as the license, and `https://github.com/nicobailon/pi-mcp-adapter` as the repository.
The npm tarball metadata records SHA-1 `b9c9fa6bec520d01f2838ff08bcc034253ef28cd` and Git commit `82724dccc13a49310530898f922bafff12b7f3fe`.
The immutable [v2.11.0 source commit](https://github.com/nicobailon/pi-mcp-adapter/commit/82724dccc13a49310530898f922bafff12b7f3fe) matches the installed `package.json`, README, entry point, panel, command, initialization, transport, and utility source blobs inspected for this report.
The package declares `./index.ts` as its Pi extension entry point in [`package.json`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/package.json#L32-L36) and lists Pi coding agent `^0.79.1` as a development dependency in [the same file](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/package.json#L100-L107).
The live `pi` command resolves to `/nix/store/xmvyk4xwa1gcxxyhj0bnh6lcp7vlr2bh-pi-coding-agent-0.87.0/bin/pi` and reports version 0.87.0.
That runtime corresponds to official Pi [commit `16787ad5b2dc748047f314ca1bfe7708f30f54f3`](https://github.com/earendil-works/pi/commit/16787ad5b2dc748047f314ca1bfe7708f30f54f3), tagged `v0.87.0`.
The [npm registry listing](https://www.npmjs.com/package/pi-mcp-adapter/v/2.36.0) reported adapter 2.36.0 as the current `latest` release on the research date, while this repository remains deliberately pinned to 2.11.0.

## Current dotfiles configuration

[`home/.pi/agent/mcp.json`](../../home/.pi/agent/mcp.json#L1-L104) defines five effective user-level servers named `supabase-staging`, `supabase-production`, `stripe`, `signalhouse`, and `composio-gmail`.
Both Supabase definitions use bearer authentication, read `SUPABASE_ACCESS_TOKEN` through `bearerTokenEnv`, and use the lazy lifecycle.
All five definitions use the lazy lifecycle, so inspecting status must not itself connect them.
The current [`home/.pi/agent/keybindings.json`](../../home/.pi/agent/keybindings.json) has no `Ctrl+M` binding.
[`home.nix`](../../home.nix#L324-L387) links the settings, MCP configuration, keybindings, custom footer extension, and Supabase Keychain extension into `~/.pi/agent` through Home Manager out-of-store symlinks.
An untracked `home/.pi/agent/extensions/mcp-shortcut.ts` draft and a corresponding `home.nix` link edit appeared concurrently after the baseline inspection and were not authored or modified by this research.
That draft listens for enhanced Ctrl+M terminal encodings and dispatches `/mcp`, so it can open the adapter panel but cannot add PAT readiness inside the panel.

## Current footer and Supabase status behavior

The text `Supabase MCP: PAT ready` is produced by this repository rather than by `pi-mcp-adapter`.
[`supabase-keychain/index.ts`](../../home/.pi/agent/extensions/supabase-keychain/index.ts#L4-L45) owns status ID `supabase-mcp-auth`, sets `Supabase MCP: PAT unavailable` and an error notification after token-resolution failure, sets `Supabase MCP: PAT ready` after success, and clears the status during session shutdown.
[`supabase-keychain/auth.ts`](../../home/.pi/agent/extensions/supabase-keychain/auth.ts#L3-L47) first accepts a non-empty process environment value and otherwise reads the macOS Keychain service `Arena Supabase MCP` with account `SUPABASE_ACCESS_TOKEN`.
That resolver returns the token and its source, but menu code should retain only a readiness boolean or enum and must never retain or render the token value.
The adapter itself uses status ID `mcp` for `MCP: <connected>/<total> servers` and uses `mcp-auth` during authentication.
The current custom footer already defines `HIDDEN_STATUS_IDS` as `mcp`, `mcp-auth`, and `supabase-mcp-auth` in [`ui-customization/index.ts`](../../home/.pi/agent/extensions/ui-customization/index.ts#L48).
The same footer calls `footerData.getExtensionStatuses()` and removes those three IDs before rendering extension rows in [`ui-customization/index.ts`](../../home/.pi/agent/extensions/ui-customization/index.ts#L225-L276).
The repository source therefore already suppresses both the routine Supabase PAT line and the adapter's routine MCP lines from the custom footer.
If `Supabase MCP: PAT ready` is still visible in a running Pi process, the first diagnostic is `/reload` or a fresh Pi process because an already-running process can retain extension code loaded before the footer filter was present.
No runtime reload or application setting change was performed during this research.

## Adapter 2.11.0 commands and panel

The adapter registers the exact extension commands `mcp` and `mcp-auth` in [`index.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/index.ts#L160-L252).
`/mcp` and `/mcp status` open the same interactive panel when Pi has a UI, while the non-UI path displays textual status.
`/mcp setup` opens guided configuration, `/mcp tools` lists tools, `/mcp reconnect` reconnects every server, `/mcp reconnect <server>` reconnects one server, and `/mcp logout <server>` removes stored OAuth credentials for one server.
`/mcp-auth` opens an OAuth server picker, and `/mcp-auth <server>` starts OAuth for the named server.
The official [2.11.0 command table](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/README.md#L405-L420) documents those public command names.
The README describes `/mcp` as an interactive panel showing all servers, connection status, tools, and direct/proxy toggles in [its interactive-configuration section](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/README.md#L297-L303).
The implementation opens a centered width-82 overlay through `ctx.ui.custom()` in [`commands.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/commands.ts#L346-L388).
The panel constructs one row for every configured server and combines current connection state with cached tool metadata in [`mcp-panel.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/mcp-panel.ts#L177-L253).
Its runtime states are `connected`, `idle`, `failed`, `needs-auth`, and `connecting`, although the normal panel renders explicit text only for `needs auth`, `connecting`, and `failed`.
The non-UI status path distinguishes `connected`, `needs auth`, recent `failed`, `cached`, and `not connected` in [`commands.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/commands.ts#L23-L60).
The panel resolves navigation through the Pi action IDs `tui.select.up`, `tui.select.down`, and `tui.select.confirm`, which normally correspond to Up, Down, and Enter.
Within the panel, Space toggles direct/proxy selection, Enter expands or authenticates, `ctrl+a` authenticates, `ctrl+r` reconnects, `?` searches descriptions, `ctrl+s` saves, Escape clears or closes, and `ctrl+c` quits.
Those input handlers and displayed hints are implemented in [`mcp-panel.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/mcp-panel.ts#L341-L505) and [`mcp-panel.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/mcp-panel.ts#L747-L766).
The built-in panel is not read-only because Space followed by `ctrl+s` can write direct-tool configuration.

## Adapter 2.11.0 extension boundary

Adapter 2.11.0 never calls `pi.registerShortcut`, so it provides no global opener key and no built-in `Ctrl+M`.
The package does not emit or subscribe to an adapter-specific Pi event-bus channel and does not expose a public runtime-status snapshot.
The live adapter state is a private closure variable in its entry point, and the exported `openMcpPanel()` function requires that private state plus internal callbacks.
Although source files are present in the package, deep-importing those internals would not be a supported extension API and would still not provide another extension with the private live state.
Pi's `pi.getCommands()` returns command metadata rather than callable command handlers, so it is not a direct command-invocation API.
Pi 0.87.0 can nevertheless dispatch an extension command by sending `/mcp` with `pi.sendUserMessage("/mcp", { expandPromptTemplates: true })`, as documented in [the user-message API](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/extensions.md#L1542-L1570).
That dispatch provides a supported 2.11.0 shortcut wrapper for the unmodified `/mcp` panel, but it does not provide a way to add PAT state inside that panel.

## Missing PAT behavior in adapter 2.11.0

The adapter resolves `bearerTokenEnv` by reading the named process environment variable and returns `undefined` when the variable is absent in [`utils.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/utils.ts#L89-L94).
The HTTP transport adds the `Authorization` header only when the resolved token is truthy in [`server-manager.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/server-manager.ts#L283-L297).
An absent Supabase PAT is therefore not represented as a distinct adapter panel state.
Because both Supabase servers are lazy, the absence can remain invisible until a connection is attempted, after which 2.11.0 exposes only a generic recent failure.
The adapter's `needs-auth` state is its OAuth state and is not a general missing-bearer-credential state.
The failure tracker lasts 60 seconds and stores a timestamp rather than a durable credential diagnosis in [`init.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/init.ts#L27-L27) and [`init.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/init.ts#L294-L299).

## Pi 0.87.0 APIs applicable to the design

Pi registers slash commands with `pi.registerCommand(name, options)` as documented in [extensions.md](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/extensions.md#L1628-L1661).
Pi registers extension shortcuts with `pi.registerShortcut(shortcut, options)` as documented in [extensions.md](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/extensions.md#L1741-L1752).
The exact requested shortcut string is `ctrl+m`, and no current repository keybinding or adapter 2.11.0 shortcut claims it by name.
Pi's documented key format accepts `ctrl` plus letters in [`keybindings.md`](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/keybindings.md#L1-L23).
`keybindings.json` remaps registered Pi action IDs and cannot bind a key directly to `/mcp`, so `pi.registerShortcut("ctrl+m", ...)` is the relevant extension API.
Pi also exposes the lower-level `ctx.ui.onTerminalInput(handler)` API, whose handler can consume raw input and whose return value unsubscribes the listener, in [`types.ts`](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/src/core/extensions/types.ts#L118-L151).
That raw-input API can reject carriage return and newline before matching enhanced Ctrl+M encodings, which prevents ordinary Enter from being consumed but makes the shortcut unavailable on legacy routes that cannot distinguish the keys.
Shortcut code that dispatches `/mcp` should check `ctx.isIdle()` because `pi.sendUserMessage()` requires a delivery mode while Pi is streaming.
Pi creates independent custom UI with `ctx.ui.custom()` and supports modal overlays with `{ overlay: true, overlayOptions }` in [the custom-component documentation](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/extensions.md#L2809-L2872).
Pi writes persistent extension footer rows with `ctx.ui.setStatus(key, text)` and lets a custom footer inspect them through `footerData.getExtensionStatuses()` in [the status and footer documentation](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/docs/extensions.md#L2664-L2703).
Pi's shared `pi.events` bus is the supported transport used by newer adapter releases for sanitized runtime snapshots.

## Ctrl+M terminal collision

Pi's key decoder derives legacy Ctrl+letter input with `code & 0x1f`, which maps Ctrl+M to byte 13, or carriage return, in [`keys.ts`](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/tui/src/keys.ts#L740-L759).
The same decoder accepts carriage return as unmodified Enter in [`keys.ts`](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/tui/src/keys.ts#L878-L932).
An installed-runtime probe confirmed that `matchesKey("\r", "enter")` and `matchesKey("\r", "ctrl+m")` both return `true`.
Extension shortcut handlers run before editor keybindings in [`interactive-mode.ts`](https://github.com/earendil-works/pi/blob/16787ad5b2dc748047f314ca1bfe7708f30f54f3/packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2142-L2197), so a legacy carriage-return route can cause a `ctrl+m` extension shortcut to intercept ordinary Enter.
Kitty keyboard protocol or `modifyOtherKeys` can encode Ctrl+M distinctly, but the exact Ghostty, tmux, fullscreen, and regular-mode paths must be tested rather than assumed.
If the deployed terminal path cannot distinguish the keys, `alt+m` or `ctrl+shift+m` is a safer fallback and requires explicit user approval because it changes the requested shortcut.

## Newer official adapter capabilities

Adapter 2.13.0 added a versioned sanitized runtime-status snapshot on Pi's shared event bus, and the [2.17.0 changelog](https://github.com/nicobailon/pi-mcp-adapter/blob/82c631dca1b9217701af0ccfe763ef3b79cd1ec0/CHANGELOG.md#L56-L64) records that addition.
The exact exported constant is `MCP_STATUS_EVENT`, and its exact value is `pi-mcp-adapter/status/v1` in [2.17.0 `types.ts`](https://github.com/nicobailon/pi-mcp-adapter/blob/82c631dca1b9217701af0ccfe763ef3b79cd1ec0/types.ts#L8-L37).
The supported subscription imports `MCP_STATUS_EVENT` and `McpStatusSnapshot` from `pi-mcp-adapter`, then calls `pi.events.on(MCP_STATUS_EVENT, handler)` as documented in the [2.17.0 README](https://github.com/nicobailon/pi-mcp-adapter/blob/82c631dca1b9217701af0ccfe763ef3b79cd1ec0/README.md#L139-L154).
The version-1 server statuses are `connected`, `cached`, `failed`, `needs-auth`, `not-connected`, and `disabled`.
The snapshot includes per-server name, status, tool count, optional resource count, optional recent-failure age, and disabled state, plus aggregate tool, resource, connection, and disabled counts.
Reading this snapshot does not connect lazy servers, start authentication, or expose SDK clients, transports, credentials, or server definitions.
The snapshot deliberately has no bearer-token or PAT-readiness field, so the local menu must merge it with a separate sanitized Supabase auth state.
Adapter 2.17.0 added `settings.mcpFooterStatus` according to its [release changelog](https://github.com/nicobailon/pi-mcp-adapter/blob/82c631dca1b9217701af0ccfe763ef3b79cd1ec0/CHANGELOG.md#L10-L19).
The exact values are `full`, `compact`, and `off`, and `off` clears the adapter's persistent footer status while leaving `/mcp status` available according to the [2.17.0 README](https://github.com/nicobailon/pi-mcp-adapter/blob/82c631dca1b9217701af0ccfe763ef3b79cd1ec0/README.md#L275-L284).
No adapter release through the currently published [2.36.0 source](https://github.com/nicobailon/pi-mcp-adapter/tree/c00e66b5b959f3327ebefddd93fffe8d402694a3) registers a global `Ctrl+M` shortcut.

## Recommended implementation

First, verify the current custom footer in a freshly reloaded Pi process because the checked-in renderer already filters `supabase-mcp-auth`, `mcp`, and `mcp-auth`.
Keep the existing token-loading behavior and one-time missing-token notification, but treat routine PAT readiness as menu state rather than persistent footer content.
Upgrade the exact adapter pin to a separately reviewed release at or above 2.17.0, with 2.36.0 as the current candidate rather than an unbounded version range.
Set `settings.mcpFooterStatus` to `off` if adapter ownership of its generic footer line should also be disabled, although the present custom footer already filters that status ID.
Add a small local status-menu extension that subscribes to `MCP_STATUS_EVENT` and retains only the latest sanitized snapshot.
Prefer an enhanced-input-only `ctx.ui.onTerminalInput()` handler that rejects `\r` and `\n` before matching `ctrl+m`, because Pi's high-level shortcut matcher otherwise accepts legacy Enter as Ctrl+M.
Use `pi.registerShortcut("ctrl+m", ...)` only if end-to-end testing proves that both ordinary Enter and Ctrl+M arrive as distinct encodings throughout every supported terminal route.
Have the shortcut open a read-only centered `ctx.ui.custom()` overlay rather than dispatch `/mcp`, so the menu can safely merge adapter runtime state with the Supabase readiness enum.
Display all effective snapshot servers and annotate `supabase-staging` and `supabase-production` with only `PAT ready` or `PAT unavailable`.
Keep `/mcp` as the separate management surface for authentication, reconnects, tool inspection, and direct/proxy configuration.
Clear the stored snapshot and unsubscribe during shutdown or reload so repeated `/reload` operations do not duplicate listeners.
Do not parse the adapter's private state, panel output, or cache when the public event is available.

The smallest 2.11.0-only alternative is a `Ctrl+M` wrapper that dispatches `/mcp` through `pi.sendUserMessage("/mcp", { expandPromptTemplates: true })`.
That alternative reuses the existing panel without a fork, but it cannot satisfy the requirement to show missing PAT inside the same menu.
A maintained adapter fork could register the shortcut and add an annotation hook inside the original panel, but that creates avoidable private-state and upgrade ownership.
A bespoke 2.11.0 menu that parses `mcp.json` and metadata cache can list configured servers but cannot reliably reproduce live connection state, config precedence, or adapter lifecycle state.

## Tests required before implementation acceptance

- Assert that a fresh or reloaded Pi footer does not render `Supabase MCP: PAT ready`, `Supabase MCP: PAT unavailable`, `MCP: ...`, or transient `mcp-auth` content while unrelated extension statuses still render.
- Assert that the status menu lists exactly the five effective configured servers without connecting any lazy server.
- Assert that public snapshot states map correctly for connected, cached, failed, needs-auth, not-connected, and disabled servers.
- Assert that a present PAT renders only `PAT ready` for both Supabase rows and never exposes the token, token prefix, Keychain output, or environment value.
- Assert that an absent or empty PAT renders `PAT unavailable` for both Supabase rows without attempting a Supabase connection.
- Assert that status inspection performs no OAuth flow, provider call, configuration write, or direct-tool change.
- Assert that `Ctrl+M` opens the overlay while Pi is idle and that `/hotkeys` reports it only if the high-level `registerShortcut` path is selected.
- Assert in Ghostty with and without tmux that ordinary Enter still submits while Ctrl+M opens the menu in both regular and fullscreen TUI modes.
- Reject `Ctrl+M` and choose an explicitly approved fallback if either route delivers ordinary Enter as the same carriage-return input accepted by the shortcut.
- Assert that Escape and Ctrl+C close the menu and restore editor focus without changing configuration.
- Assert that pressing the shortcut during streaming produces a bounded warning or no-op and does not inject an MCP command into the conversation.
- Assert that `/reload` recreates one subscription and one shortcut without duplicate handlers or stale rows.
- Assert that `/mcp`, `/mcp status`, `/mcp-auth`, reconnect, and direct/proxy management retain their adapter behavior after the version upgrade.
- Assert that `settings.mcpFooterStatus: "off"`, if adopted, removes only the adapter footer status and does not disable `/mcp status` or the public snapshot.
- Run the existing Supabase resolver tests and add focused footer-filter, snapshot-merging, menu-rendering, secret-redaction, and keyboard-input tests.

## Research limits

This research changed no source file, settings file, package version, runtime state, provider connection, OAuth flow, or Keychain item.
No live provider was contacted, and no attempt was made to connect the lazy MCP servers.
The latest-release observation is time-sensitive, while all installed-version conclusions are pinned to immutable 2.11.0 and Pi 0.87.0 source commits.
