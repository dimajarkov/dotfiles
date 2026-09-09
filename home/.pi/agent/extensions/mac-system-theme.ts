import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const DARK_THEME = "prime";
const LIGHT_THEME = "catppuccin-latte";
const FALLBACK_INTERVAL_MS = 500;
const WATCH_DEBOUNCE_MS = 100;
const preferencesPath = join(homedir(), "Library/Preferences/.GlobalPreferences.plist");

async function systemTheme(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("defaults", ["read", "-g", "AppleInterfaceStyle"], {
      timeout: 2000,
    });
    return stdout.trim() === "Dark" ? DARK_THEME : LIGHT_THEME;
  } catch (error) {
    // Light mode normally means the preference is absent. Other failures
    // should leave the current palette alone rather than flash a light UI.
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === 1 &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.includes("AppleInterfaceStyle") &&
      error.stderr.includes("does not exist")
    ) {
      return LIGHT_THEME;
    }
    return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | undefined;
  let fallbackInterval: ReturnType<typeof setInterval> | undefined;
  let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
  let stopSync: (() => void) | undefined;

  const cleanup = () => {
    stopSync?.();
    stopSync = undefined;
    watcher?.close();
    watcher = undefined;
    if (fallbackInterval) clearInterval(fallbackInterval);
    fallbackInterval = undefined;
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    if (process.platform !== "darwin" || ctx.mode !== "tui") return;

    // Each session owns its state. A defaults read completing after reload
    // or shutdown must not apply a theme through a stale UI context.
    let stopped = false;
    let syncing = false;
    let syncAgain = false;
    stopSync = () => {
      stopped = true;
    };

    const sync = async () => {
      if (stopped) return;
      if (syncing) {
        syncAgain = true;
        return;
      }
      syncing = true;
      try {
        do {
          syncAgain = false;
          const nextTheme = await systemTheme();
          if (stopped) return;
          // /reload reapplies saved settings after session_start. Compare
          // the live theme so the next poll also repairs that reset.
          if (!nextTheme || ctx.ui.theme.name === nextTheme) continue;

          const theme = ctx.ui.getTheme(nextTheme);
          if (!theme) continue;
          // Passing a Theme object changes only the live session, not the
          // Nix-managed settings file.
          ctx.ui.setTheme(theme);
        } while (syncAgain);
      } finally {
        syncing = false;
      }
    };

    await sync();
    if (stopped) return;

    // Polling also covers coalesced/missed notifications and absent folders.
    fallbackInterval = setInterval(() => void sync(), FALLBACK_INTERVAL_MS);
    fallbackInterval.unref();
    try {
      watcher = watch(dirname(preferencesPath), { persistent: false }, (_event, filename) => {
        if (filename !== ".GlobalPreferences.plist") return;
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => void sync(), WATCH_DEBOUNCE_MS);
      });
      const activeWatcher = watcher;
      activeWatcher.on("error", () => activeWatcher.close());
    } catch {
      // The polling fallback remains active if filesystem watching fails.
    }
  });

  pi.on("session_shutdown", cleanup);
}
