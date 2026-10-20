import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Keep the existing npm owner. Never download, auto-connect, or select a profile
// here: AXI supplies the exact browser endpoint and launch arguments unchanged.
const upstream = join(
  homedir(),
  ".npm-global/lib/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
);
const args = process.argv.slice(2);

function refuse(message) {
  console.error(`Chrome DevTools MCP routing refused: ${message}`);
  process.exit(78);
}

if (!existsSync(upstream))
  refuse(
    "the existing npm-owned MCP executable is missing; no fallback installation was attempted.",
  );

if (!args.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg))) {
  const incompatible = args.some((arg, index) => {
    const [name, inlineValue] = arg.split("=", 2);
    const option = name.replaceAll("-", "").toLowerCase();
    const value = inlineValue ?? args[index + 1];
    if (["nopageidrouting", "noexperimentalpageidrouting"].includes(option)) return true;
    if (["pageidrouting", "experimentalpageidrouting"].includes(option)) return value === "false";
    return option === "slim" && value !== "false";
  });
  if (incompatible) {
    refuse("AXI requires explicit page routing; disabled routing and slim mode are unsupported.");
  }
  const help = spawnSync(process.execPath, [upstream, "--help"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (help.error || help.status !== 0)
    refuse("could not inspect the selected MCP's advertised routing capability.");
  const flag = /^\s+--pageIdRouting(?:\s|$)/m.test(help.stdout)
    ? "--pageIdRouting=true"
    : /^\s+--experimentalPageIdRouting(?:\s|$)/m.test(help.stdout)
      ? "--experimentalPageIdRouting=true"
      : null;
  if (!flag) refuse("the selected MCP advertises no page ID routing capability.");
  args.push(flag);
}

// Import in this process so stdio framing, exit status and signal ownership stay
// with AXI's one transport child rather than introducing an orphanable launcher.
process.argv = [process.execPath, upstream, ...args];
await import(pathToFileURL(upstream).href);
