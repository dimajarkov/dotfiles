import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const DARK_THEME = "catppuccin-mocha";
const LIGHT_THEME = "catppuccin-latte";
const FIXED_THEME = "prime";
const FALLBACK_INTERVAL_MS = 500;
const WATCH_DEBOUNCE_MS = 100;
const preferencesPath = join(homedir(), "Library/Preferences/.GlobalPreferences.plist");

async function systemTheme(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("defaults", [
      "read",
      "-g",
      "AppleInterfaceStyle",
    ]);
    return stdout.trim() === "Dark" ? DARK_THEME : LIGHT_THEME;
  } catch {
    return LIGHT_THEME;
  }
}

export default function (pi: ExtensionAPI) {
  let watcher: FSWatcher | undefined;
  let fallbackInterval: ReturnType<typeof setInterval> | undefined;
  let debounceTimeout: ReturnType<typeof setTimeout> | undefined;
  let currentTheme: string | undefined;
  let syncing = false;
  let syncAgain = false;

  const sync = async (ctx: ExtensionContext) => {
    if (syncing) {
      syncAgain = true;
      return;
    }

    syncing = true;
    try {
      do {
        syncAgain = false;
        const nextTheme = await systemTheme();
        if (nextTheme === currentTheme) continue;

        const theme = ctx.ui.getTheme(nextTheme);
        if (!theme) continue;

        const result = ctx.ui.setTheme(theme);
        if (result.success) currentTheme = nextTheme;
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  };

  const cleanup = () => {
    watcher?.close();
    watcher = undefined;
    if (fallbackInterval) clearInterval(fallbackInterval);
    fallbackInterval = undefined;
    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    cleanup();
    currentTheme = undefined;

    // Prime Agent uses one fixed brand theme rather than a light/dark pair.
    // Leave the system-theme watcher disabled while that theme is available.
    if (ctx.ui.getTheme(FIXED_THEME)) {
      const result = ctx.ui.setTheme(FIXED_THEME);
      if (result.success) {
        currentTheme = FIXED_THEME;
        return;
      }
    }

    await sync(ctx);

    watcher = watch(dirname(preferencesPath), (_event, filename) => {
      if (filename !== ".GlobalPreferences.plist") return;
      if (debounceTimeout) clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => void sync(ctx), WATCH_DEBOUNCE_MS);
    });

    fallbackInterval = setInterval(() => void sync(ctx), FALLBACK_INTERVAL_MS);
  });

  pi.on("session_shutdown", cleanup);
}
