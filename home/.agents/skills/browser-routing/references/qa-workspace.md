# Chrome QA workspace recovery

Use `scripts/qa-route.mjs` from the owning repository for Chrome for Testing native workspace recovery and before native input.
For auth, diagnostics and page screenshots, read [background operations](background-and-resize.md); those commands do not need this native focus handshake.
It saves the repository, task slug, browser process birth identity, executable, private profile inode, loopback endpoint generation, exact tab ID, native window ID, CDP window ID, and AeroSpace workspace.
This is routing evidence; repository authentication, runtime leases, provider guards and mutation authorization remain owned by their existing helpers.

## Acquire

For application repositories such as Arena, first use the repository-owned runtime and isolated browser launcher and verify its lifecycle owner.
Attach its existing browser instead of launching a second instance:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs attach --state /private/tmp/qa-example/route.json --task arena-3470 --pid <verified-pid> --port <verified-port> --profile <verified-private-profile> --owner <repository-lifecycle-receipt>
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs targets --state /private/tmp/qa-example/route.json --task arena-3470
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs bind --state /private/tmp/qa-example/route.json --task arena-3470 --target <exact-target-id> --url <exact-approved-url>
```

Choose the explicit target using the intended URL and task state; duplicate matches need further identification.
The helper briefly challenges that tab's title with a random marker, maps the native window by process plus marker, and restores the title in `finally`.
CDP IDs and native window IDs are separate namespaces.
Title mapping requires a writable HTML title; unsupported pages stop before native input.
Tab navigation during mapping can interrupt restoration, so verify the ordinary title before capture.

For this dotfiles helper's own synthetic fixture proof, `start` creates a fresh disposable Nix-owned Chrome for Testing profile and records its lifecycle before waiting for readiness:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs start --state /private/tmp/qa-example/route.json --task routing-example --port <unused-port> --url <synthetic-loopback-url>
```

`attach` and `bind` support a caller-approved HTTPS origin or loopback HTTP origin, and constrain subsequent recovery to that origin.
`start` supports loopback HTTP only and supplies no application authentication or runtime provisioning.
Application QA continues through its repository's launcher and `attach`.
State files are private and must remain outside public evidence.
Use a distinct task slug for each concurrent task or new proof run; reuse its state during retries and handoffs.
An existing state is never overwritten by `start` or `attach`.

## Return to the task

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs focus --state /private/tmp/qa-example/route.json --task arena-3470
```

A successful result verifies the live process/profile/endpoint, exact tab, window mapping, focused window, selected tab, workspace and monitor.
By default, the workspace name is derived from the task slug plus repository identity.
When the user explicitly names an existing workspace, pass `--workspace warrior-v2` to `attach` or `start`; the saved binding retains that choice for bind, focus and native confirmation.
Explicit workspaces keep their current monitor and other windows; only the exact owned QA window moves.
Create a new private route file when changing the requested workspace or attaching another tab of the same owned browser; preserve the earlier receipt.
Omitting the option retains the isolated derived-workspace behavior below.
The helper restores a displaced owned window to that workspace and prefers an external display, keeping the previous external display when available, then Samsung, Lenovo, another external display, or the built-in display when no external monitor is connected.
Monitor IDs are discovered again after display changes.
A workspace containing another window is preserved and reported as blocked before moving that workspace.

Before native input, run the acquisition handshake:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs native-prepare --state /private/tmp/qa-example/route.json --task arena-3470
# Select the exact testing app through Codex Computer Use and read its fresh window title.
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs native-confirm --state /private/tmp/qa-example/route.json --task arena-3470 --observed-title <title-actually-observed-through-Computer-Use>
```

`native-prepare` recovers the route and briefly gives the exact tab a unique title.
Pass the title actually returned by Computer Use to `native-confirm`; copying the expected marker from the helper is not native evidence.
Confirmation checks the observed marker, foreground window and focused tab, then restores the ordinary title, including on mismatch.
Read fresh native state after confirmation before choosing native input indices.
Background renderer screenshots use ownership/document checks and do not require native confirmation.
`focus` verifies OS/CDP routing only; its success does not establish that Computer Use selected the same process.

The live macOS test on 28 October 2026 found that app-path selection can return a different Chrome for Testing process even after AeroSpace focused the intended window.
Native acquisition passed for two windows within the selected process; acquisition of another process returned the wrong window and was rejected by the title handshake.
The current macOS Computer Use API exposes app-name/path/bundle selection, without the exact-window selector available on Linux and Windows.
AeroSpace cannot change that app-handle binding.
On a mismatch, restore the title through `native-confirm`, stop input and report the missing exact-process acquisition capability; preserve the other browser rather than closing it to force selection.
Native acquisition remains unproven for that process until a supported route passes this handshake.
Stop input on any AX/screenshot/window mismatch, including when a matching URL is shown.
Do not rely on cached accessibility indices after switching windows.

For diagnostics, use the saved endpoint and exact target through tools that support explicit target selection.
Tool-specific page IDs can differ from CDP target IDs; resolve them against the saved endpoint and URL rather than treating the numbers as interchangeable.
A tool that only guesses an active tab is unsuitable when multiple candidates exist.
Native Computer Use remains serialized across tasks because all workspaces share the desktop's keyboard, pointer and foreground focus.

A closed tab, moved-to-another-window tab, changed process identity, replaced profile or reused endpoint fails closed.
Use `bind` deliberately for a confirmed replacement tab; it never creates one or silently substitutes a matching URL.
Recheck the repository runtime before rebinding after a browser restart.

## Close

For a helper-owned `start` browser:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs stop --state /private/tmp/qa-example/route.json --task routing-example
```

For an attached browser, use its recorded repository lifecycle owner; this helper refuses to stop browsers it did not launch.
Verify exact process exit and released endpoints, then retain only private recovery files and reviewed evidence.
Temporary workspaces disappear when empty; do not close or move other windows to empty a workspace.
The helper never changes persistent AeroSpace rules or personal workspace names.

## Repeat the regression proof

From the dotfiles repository, run `node --test tests/qa-route.test.mjs` for pure rejection/selection checks.
Run `node tests/fixtures/browser-routing-recovery.mjs --live --auto` for the bounded live proof with two disposable browser processes, three windows, duplicate titles and a decoy tab.
It tests thirty workspace/window/tab recoveries on the preferred monitor, rejected stale process/profile/endpoint identities, a closed target, wrong native observation, title restoration during rebinding, and ownership-scoped cleanup while preserving pre-existing windows.
It writes private source-hashed receipts in the printed temporary directory and does not claim native Computer Use acceptance from CDP checks.
For native acceptance, omit `--auto`, perform the title handshake and native interaction while the fixture reports `ready`, then create `continue.request` in the printed directory to start the automated loop.
Wait for `cycles-passed` before further native interaction, then create `stop.request` to close only fixture-owned browsers.
The manual stage has a ten-minute deadline; the fixture always attempts ownership-checked cleanup on failure.
