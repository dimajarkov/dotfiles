import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const localPackage = join(
  extensionDirectory,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
);
if (existsSync(localPackage)) process.exit(0);

const npmEnvironment = { ...process.env };
delete npmEnvironment.npm_config_prefix;
delete npmEnvironment.npm_config_global_prefix;
delete npmEnvironment.npm_config_globalconfig;
const globalRoot = execFileSync("npm", ["root", "--global"], {
  encoding: "utf8",
  env: npmEnvironment,
}).trim();
const globalPackage = join(globalRoot, "@earendil-works", "pi-coding-agent");
if (!existsSync(globalPackage)) {
  throw new Error("@earendil-works/pi-coding-agent is not installed globally");
}

mkdirSync(dirname(localPackage), { recursive: true });
symlinkSync(globalPackage, localPackage, "dir");
