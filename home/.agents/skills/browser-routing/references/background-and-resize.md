# Background browser operations and sizing

Choose the exact owned browser process/profile/endpoint and page before running a command.
Ownership is independent of the desktop's foreground window.
A browser launch or explicit native setup may focus a window; the commands below operate on an already-owned browser without activation, workspace switching, native title changes or focus requirements.
Background receipts do not grant native input authority.

## Bind without taking focus

Use the repository's isolated launcher and authentication/lifecycle boundaries first.
Attach its existing process, then bind the exact tab through the background route rather than the native `bind` command:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs attach --state <new-private-route-file> --task <task-slug> --pid <owned-pid> --port <owned-port> --profile <private-profile> --owner <repository-lifecycle-receipt>
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs bind-background --state <route-file> --task <task-slug> --target <exact-tab-id> --url <exact-approved-url>
```

Run from the owning runtime repository.
The helper revalidates the saved runtime identity, process birth/UID/executable, profile inode, endpoint listener/generation, exact page and CDP window.
Background operations additionally compare the page URL, main-frame loader/document identity and binding before and after the operation, and latch navigation events.
A stale or missing tab stops the command; there is no active/first/last-tab fallback.
Finish or cancel a pending native acquisition before background work on the same route.

## Authentication

For Arena, use its canonical `auth background-target` stage with explicit existing synthetic subject and owned route/runtime inputs; read `docs/references/tools/browser-tools/auth-and-local-state.md` in the approved helper checkout for the complete flags.
The stage retains active lease/lifecycle, tenant, signing, cookie acceptance, navigation and replay checks while removing native title/foreground requirements.
Do not inject ad-hoc cookies, type passwords, reuse personal profiles or substitute a fixture authentication result for an Arena login result.
Use only a helper head that the runtime owner has reviewed and adopted; a code-only source change does not update a running integration.

## Diagnostics and screenshots

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs diagnostics --state <route-file> --task <task-slug>
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs screenshot --state <route-file> --task <task-slug> --path <new-private-png>
```

Diagnostics expose bounded geometry/readiness and performance metrics, not cookies, storage dumps, identity data or raw network payloads.
The screenshot command uses the exact page's renderer surface and writes a new private PNG only after ownership/document revalidation.
Use Arena's repository-owned exact-session screenshot command when its evidence contract requires it; that existing background command takes `--session-dir`, `--target-id`, `--url` and `--path`.
Neither background capture path calls `Page.bringToFront` or needs the native title handshake.
A screenshot is evidence of rendered pixels, not evidence of a native click, OS cursor, dialog or keyboard journey.

## Responsive viewport sizing with AeroSpace enabled

For responsive layout/screenshot checks, prefer a target-only renderer viewport override:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs viewport --state <route-file> --task <task-slug> --width 600 --height 700
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs screenshot --state <route-file> --task <task-slug> --path <new-private-narrow-png>
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs viewport-reset --state <route-file> --task <task-slug>
```

Subsequent helper operations temporarily change the selected tab's CSS viewport without resizing its native window, moving other tabs/windows, disabling AeroSpace or taking foreground focus.
`viewport` saves a policy for subsequent helper diagnostics/screenshots; it does not keep an emulation session alive between commands.
Each operation reapplies that policy, holds the same connection through sizing/measurement/capture, checks actual PNG size against CSS dimensions and DPR, clears in `finally`, and verifies baseline restoration before publishing pixels.
Use `screenshot --width 600 --height 700` for a single atomic capture without saving a policy.
`dontSetVisibleSize` keeps the renderer's native surface size intact; an inactive page can otherwise fail to restore correctly.
Do not split emulation setup and screenshot across separate connections and assume the dimensions persist.
Verify native geometry with CDP window bounds rather than JavaScript `outerWidth`, which Chrome can spoof during emulation.
Coordinate other emulation tools with the same owner: the helper cannot reconstruct an override installed independently by another controller.
Report actual CSS width/height, DPR, visual scale and CSS zoom from the receipt; label this an emulated viewport rather than a physical native window resize.
Reset the helper-owned override before native input; `native-prepare` rejects a configured viewport policy to avoid coordinate mismatches.
A restore failure retains recovery state and is not a completed proof.

For a physical Chrome window resize, a visible AeroSpace tiled/fullscreen window can immediately override Chrome's bounds request.
The isolated reproduction found both `Browser.setWindowBounds` and `Browser.setContentsSize` ineffective in that visible state; hidden-workspace resizing behaved differently.
Use the scoped native path only for an explicitly mapped window in a workspace containing no other windows:

```sh
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs window-resize --state <route-file> --task <task-slug> --width 600 --height 700
node ~/.agents/skills/browser-routing/scripts/qa-route.mjs window-restore --state <route-file> --task <task-slug>
```

Before mutation it saves actual bounds, layout, fullscreen state, monitor and page metrics in `resizeOriginal`.
It turns off AeroSpace fullscreen for the exact window, makes that window floating, and requests Chrome content size; AeroSpace remains enabled.
Restoration requires the same identities/monitor, restores original bounds/layout/fullscreen and verifies exact geometry before deleting recovery state.
Fullscreen gap options are not fully represented by AeroSpace's Boolean metadata, so exact readback is required and unsupported restoration remains explicitly blocked.
A shared workspace is refused because changing a tiled window can reflow siblings; use target-only viewport sizing there.
A physical resize affects all tabs in that window, so include them in the task's mutation scope.
The native path requires the intended tab to be selected/visible; inactive tabs can retain stale CSS dimensions, so they must use the background viewport path.
Native macOS fullscreen/minimized/maximized windows are outside this bounded restoration path.

## Regression proof

Run `node --test tests/qa-route.test.mjs tests/browser-background.test.mjs` from dotfiles for pure routing and resize rejection checks.
Run `node tests/fixtures/browser-background.mjs --live` for the bounded loopback proof.
It creates only its own disposable profiles, reproduces visible tiled/fullscreen native resize refusal, then keeps a sentinel window focused while an inactive exact tab logs into a synthetic HTTP fixture, emits diagnostics, and captures wide/narrow PNGs.
The narrow image must match 600x700 CSS before and after capture and 1200x1400 pixels at DPR2; policy reset, native bounds, decoy tab and foreground identity are checked.
The final separate native stage selects only the owned tab, verifies floating physical resizing, and restores exact original bounds/layout/fullscreen.
Cleanup probes actual process/endpoint exit and refreshes native survivors while preserving all pre-existing windows.
The synthetic HTTP login proves browser transport only; canonical Arena authentication has its own CLI ownership/signing/cookie tests and runtime-owner acceptance.
