# Historical native Codex compatibility acceptance

This record retains earlier version and fixture diagnoses.
The current entrypoint delegates to npm Codex 0.162.1, and fresh native API compatibility checks pass.
See [current finalization evidence](hunk-turn-review-finalization.md) for the exact package and the separate unresolved Herdr/Bash registration blocker.

## Reproduced failure and exact cause

The ordinary `/opt/homebrew/bin/codex` route starts native Codex 0.160.1.
The retained app-server executable is 0.162.1.
Both versions were tested in fresh owner-private `CODEX_HOME` directories using local deterministic providers and the actual runtime/client/socket interface.
No running user daemon or original conversation was used.

The original command reproduced the reported failure before changes:

```sh
cd home/.local/share/hunk-turn-review
HTR_CODEX_BINARY=/opt/homebrew/bin/codex bun test tests/codex-native.test.ts
```

It passed 17 public runtime cases and failed the native scenario after approximately 16 seconds.
The displayed `Native session is missing or ambiguous; specify the exact session path` was a stale error from an earlier poll, not the condition that timed out.
The existing fixture retains `lastError` across every invocation of its wait helper.
Its final wait returned false repeatedly without throwing, leaving the earlier lookup error in the failure message.

The independent public trace identified the failing phase as **original server exit**.
Before that phase, SessionStart and subsequent hooks carried the same transcript path as native `thread/start` and read-only `thread/read`.
Exact-path and path-omitted `session.find` returned the same single session, receiver, and epoch.
Stop continuation completed with the correct pre-request baseline and final bytes.
Feedback was admitted through `thread/queue/add`, reconciled, persisted with the exact batch client ID, and published as a completed response.
The duplicate-session/path-enrichment hypothesis was not reproduced on this route.

The actual cause is process ownership in the fixture.
`/opt/homebrew/bin/codex` is a zsh wrapper that execs `~/.npm-global/bin/codex` for `app-server`.
That Node launcher spawns the native executable and forwards SIGINT, SIGTERM, and SIGHUP, but SIGKILL cannot be forwarded.
The existing fixture's `native.kill("SIGKILL")` terminates the Node launcher and leaves its native listener alive.
The public regression verifies that after the launcher exits, the exact original endpoint still lists the original loaded UUID and `thread/read` reports that same active thread.
Keeping the binding alive at that point is correct.
Killing the fixture-owned process group actually terminates the listener, after which the observer automatically detaches and the runtime publishes an interrupted review.

## Scoped changes

`home/.codex/hunk-turn-review/adapter.mjs` now subscribes using `thread/read` with `includeTurns:false` after proving the exact original UUID is loaded.
It no longer uses `thread/resume` to observe an already loaded conversation.
Both actual native versions support this read-only metadata shape.
This is an observation-only change, not a new session identity scheme.
UUID, canonical checkout, native working directory, transcript path, receiver, epoch, loaded status, and exact connection checks remain intact.
The bounded RFC 6455 transport and its handling of native approval/tool/authentication requests are unchanged.

`tests/hunk-codex-compatibility.test.ts` is an independent public integration regression with its own runtime, checkout, provider, hooks, listener, and cleanup per test.
It does not import the shared runtime test fixture or mock internal methods.
The native listener runs in an isolated process group so crash assertions and cleanup terminate only its owned processes, including the Node wrapper's child.
Its Codex environment excludes inherited user credentials and Herdr pane/session configuration.

The first scenario proves authentic hook capture, Stop continuation, one binding across hook/native metadata, exact identity/epoch refusal, admission and repeated reconciliation, actual paginated user history with one copy of the batch ID, and automatic interruption after listener death.
It also proves the wrapper-only SIGKILL diagnosis when using the ordinary `/opt/homebrew/bin/codex` entrypoint.
The second uses genuine native `ephemeral:true` threads with `path:null` to verify that unknown transcript metadata remains unknown in both adapter and runtime identities.
After replacing the owned listener at the same private pathname, the old connection refuses requests and attaching the original UUID is refused as not loaded.
The old binding retains its original session ID and epoch without acquiring a replacement receiver.
No transcript path is invented, no arbitrary session is selected, and no original observer reconnects or resumes against the replacement listener.

## Shared fixture correction needed from its owner

No core/runtime/client change is required by this reproduced failure.
The remaining failure in `home/.local/share/hunk-turn-review/tests/codex-native.test.ts` is in agent10's owned fixture, which was read but not edited.
Its required crash/cleanup correction is:

```diff
   const native = spawn(binary, ["app-server", "--listen", endpoint], {
+    detached: true,
     cwd: f.checkout,
     ...
   });
+  const killNative = () => {
+    try {
+      process.kill(-native.pid!, "SIGKILL");
+    } catch (error) {
+      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
+    }
+  };
   // At the crash boundary, and again in finally:
-  native.kill("SIGKILL");
+  killNative();
```

The negative PID is safe only with that newly created `detached:true` process group, never with a shared daemon or inherited process group.
The diagnostic correction is to move `lastError` inside each `wait` invocation and name the current wait phase in its timeout message.
The new owned regression implements isolated group cleanup and phase-specific public evidence without changing the shared fixture.

## Verification

From the repository root:

```sh
HTR_CODEX_BINARY=/opt/homebrew/bin/codex bun test tests/hunk-codex-compatibility.test.ts
HTR_CODEX_BINARY="$HOME/.codex/packages/app-server-daemon/current/codex" bun test tests/hunk-codex-compatibility.test.ts
```

After the read-only observer change, Homebrew 0.160.1 passed 2 tests / 39 assertions and retained native 0.162.1 passed 2 tests / 35 assertions.
Versions come from native `thread.cliVersion`, without invoking the ordinary wrapper's credential helper for `--version`.
The unknown-path and replacement scenario also has independent state and can run alone with `-t "unknown native transcript"`.

From `home/.local/share/hunk-turn-review`, the existing suite can also exercise the same actual 0.160.1 native executable without the Node launcher crash-fixture issue:

```sh
HTR_CODEX_BINARY="$HOME/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" bun test tests/codex-native.test.ts
HTR_CODEX_BINARY="$HOME/.codex/packages/app-server-daemon/current/codex" bun test tests/codex-native.test.ts
```

The literal `/opt/homebrew/bin/codex` version of that shared suite still requires the owner correction above; its result must not be reported as green merely because the independent regression passes.
The final rerun passed 18 tests / 133 assertions with the installed native 0.160.1 executable and also passed 18 tests / 133 assertions with retained 0.162.1.
The literal wrapper rerun remained 17 pass / 1 fail, and its stack identified `codex-native.test.ts:217`, the final post-SIGKILL wait, as the failing phase.

Focused adapter typechecking uses `./node_modules/.bin/tsc -p tsconfig.adapters.json` from the core package.
The new root test is checked with the core package's local TypeScript and Oxc tools:

```sh
home/.local/share/hunk-turn-review/node_modules/.bin/tsc --noEmit --target ES2023 --module ESNext --moduleResolution Bundler --strict --skipLibCheck --allowJs --types bun --typeRoots home/.local/share/hunk-turn-review/node_modules/@types tests/hunk-codex-compatibility.test.ts
home/.local/share/hunk-turn-review/node_modules/.bin/oxlint --deny-warnings home/.codex/hunk-turn-review tests/hunk-codex-compatibility.test.ts
home/.local/share/hunk-turn-review/node_modules/.bin/oxfmt --check home/.codex/hunk-turn-review tests/hunk-codex-compatibility.test.ts
```

These checks establish isolated native API compatibility, not ordinary Codex TUI/Hunk visual acceptance.
No UI automation bypass, shared daemon restart, launcher/alias/Nix/UI/host modification, installation, activation, production trust/configuration change, staging, or commit was performed.
Initial version probes used the ordinary wrapper's `--version` branch before that wrapper was inspected, which invokes its existing credential helper.
No credential value appeared in tool output or was used by the local providers; retained regression version checks instead read native `thread.cliVersion` through the isolated API.
Slot13's lease and concurrent work remain in place.

## Shared native fixture cleanup verification

`home/.local/share/hunk-turn-review/tests/codex-native.test.ts` now defaults to Homebrew's installed native Codex executable rather than its credential-helper wrapper.
The existing `HTR_CODEX_BINARY` environment variable continues to select an explicit native executable or wrapper route.
The fixture starts the selected executable under an owned Node launcher that forwards ordinary termination signals while the native server remains in the launcher's process group.
The crash assertion kills only the launcher first, then verifies the exact UUID remains loaded, active, and bound to the same session.
It then kills only the detached fixture-owned process group on POSIX, tolerates an already-exited group, awaits launcher exit, and confirms the owned Unix endpoint refuses new connections.
A subsequent session lookup and the deterministic HTTP provider's listening port prove the separate fixture services remain alive.
Wait failures now report the current phase and only that wait's last error.

The first controlled run failed at observer detachment after launcher `SIGKILL`, reproducing the surviving native listener.
Fixture-finally group cleanup still closed the owned endpoint after that expected red result.
The corrected default run passed 18 tests and 140 assertions.
The explicit Homebrew native executable override passed 18 tests and 140 assertions.
The retained native executable override passed 18 tests and 140 assertions.
The explicit `/opt/homebrew/bin/codex` wrapper route passed the focused native case with 1 test and 19 assertions without invoking `--version`.
The untouched root compatibility test passed 2 tests and 39 assertions, reporting native Codex 0.160.1.
These results supersede the earlier entry above that the shared fixture still failed after launcher `SIGKILL`.

Verification commands from the repository root:

```sh
cd home/.local/share/hunk-turn-review && bun test ./tests/codex-native.test.ts
cd home/.local/share/hunk-turn-review && HTR_CODEX_BINARY="$HOME/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" bun test ./tests/codex-native.test.ts
cd home/.local/share/hunk-turn-review && HTR_CODEX_BINARY="$HOME/.codex/packages/app-server-daemon/current/codex" bun test ./tests/codex-native.test.ts
cd home/.local/share/hunk-turn-review && HTR_CODEX_BINARY=/opt/homebrew/bin/codex bun test --test-name-pattern='exact isolated Codex endpoint' ./tests/codex-native.test.ts
env -u HTR_CODEX_BINARY bun test ./tests/hunk-codex-compatibility.test.ts
cd home/.local/share/hunk-turn-review && ./node_modules/.bin/oxlint --deny-warnings tests/codex-native.test.ts
cd home/.local/share/hunk-turn-review && ./node_modules/.bin/oxfmt --check tests/codex-native.test.ts
git diff --check
```

No native wrapper `--version` probe was used, and no credentials, daemon, or user conversation were accessed.
