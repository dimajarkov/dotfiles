import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Guard-derived NODE_OPTIONS only. The public CLI rejects caller NODE_OPTIONS.
// The installed bridge's SDK otherwise strips policy bindings from the MCP
// environment; the MCP title setter also erases actual Darwin argv. Keep both
// inspectable without replacing the installed bridge/CLI/MCP implementations.
if (process.env.DOTFILES_BROWSER_POLICY_MODE !== "foreground-attach") {
  throw new Error("Attached transport preload requires the repository guard");
}

const entry = realpathSync(process.argv[1]);
if (entry === process.env.CHROME_DEVTOOLS_AXI_MCP_PATH) {
  const title = process.title;
  Object.defineProperty(process, "title", {
    get: () => title,
    set(value) {
      if (value !== "chrome-devtools-mcp")
        throw new Error("Unsupported MCP process title mutation");
    },
    configurable: false,
    enumerable: true,
  });
} else if (entry.endsWith("/dist/bin/chrome-devtools-axi-bridge.js")) {
  const bridge = pathToFileURL(join(dirname(entry), "../src/bridge.js")).href;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url !== bridge) return result;
      const needle = "args: [mcpPath, ...mcpArgs.slice(2)],";
      const source = String(result.source);
      if (source.split(needle).length !== 2)
        throw new Error("Pinned attachment transport seam changed");
      return {
        ...result,
        source: source.replace(needle, `${needle}\n            env: { ...process.env },`),
      };
    },
  });
} else {
  throw new Error("Attached preload is restricted to the pinned bridge and MCP entries");
}
