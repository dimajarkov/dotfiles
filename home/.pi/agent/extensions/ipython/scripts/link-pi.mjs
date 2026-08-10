import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const npmEnvironment = { ...process.env };
delete npmEnvironment.npm_config_prefix;
delete npmEnvironment.npm_config_global_prefix;
delete npmEnvironment.npm_config_globalconfig;
const globalRoot = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
  env: npmEnvironment,
}).trim();
const globalPi = join(globalRoot, "@earendil-works", "pi-coding-agent");
if (!existsSync(globalPi)) {
  throw new Error("@earendil-works/pi-coding-agent is not installed globally");
}

const packages = new Map([
  ["@earendil-works/pi-coding-agent", globalPi],
  ["@earendil-works/pi-tui", join(globalPi, "node_modules", "@earendil-works", "pi-tui")],
  ["typebox", join(globalPi, "node_modules", "typebox")],
]);

for (const [name, source] of packages) {
  const target = join(extensionDirectory, "node_modules", ...name.split("/"));
  if (existsSync(target)) continue;
  if (!existsSync(source)) throw new Error(`Pi dependency is missing: ${source}`);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(source, target, "dir");
}
