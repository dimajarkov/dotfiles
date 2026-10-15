// Bounded repository-owned native selection proof. Run in a foreground terminal.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, openSync, closeSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const app = join(homedir(), "Applications/Google Chrome for Testing.app");
const store = dirname(dirname(realpathSync(app)));
if (!/^\/nix\/store\/[a-z0-9]{32}-chrome-for-testing-/.test(store)) throw new Error("Expected the declared Nix-owned testing app");
execFileSync("/nix/var/nix/profiles/default/bin/nix-store", ["--verify-path", store], { stdio: "pipe" });
const bundle = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")], { encoding: "utf8" }).trim();
if (bundle !== "com.google.chrome.for.testing") throw new Error("Wrong testing app identity");

const directory = mkdtempSync(join(realpathSync(tmpdir()), "chrome-selection-"));
chmodSync(directory, 0o700);
const profile = join(directory, "profile");
mkdirSync(profile, { mode: 0o700 });
const token = `CFT_${randomBytes(8).toString("hex").toUpperCase()}`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Chrome Selection ${token}</title></head><body style="font:24px system-ui;margin:40px"><h1>Dedicated Chrome selection proof</h1><p>${token}</p><p>Fabricated test data only.</p><button id="increment" style="font:inherit">Increment</button> <output id="count">0</output><p><label>Draft <input id="draft" style="font:inherit"></label></p><p id="echo"></p><script nonce="${token}">document.getElementById('increment').onclick=()=>{const c=document.getElementById('count');c.textContent=String(Number(c.textContent)+1)};document.getElementById('draft').oninput=e=>document.getElementById('echo').textContent=e.target.value;</script></body></html>`;
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${token}'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`);
  if (req.method !== "GET" || req.url !== "/") { res.writeHead(404); res.end(); return; }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const url = `http://127.0.0.1:${server.address().port}/`;
const log = openSync(join(directory, "chrome.log"), "wx", 0o600);
const chrome = spawn(join(app, "Contents/MacOS/Google Chrome for Testing"), [
  `--user-data-dir=${profile}`, "--disable-sync", "--disable-extensions",
  "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check", url,
], { stdio: ["ignore", log, log], detached: true });
closeSync(log);
const state = { app, bundle, directory, profile, url, token, pid: chrome.pid, owner: process.pid };
writeFileSync(join(directory, "state.json"), JSON.stringify(state, null, 2), { mode: 0o600 });
console.log(JSON.stringify(state));
chrome.once("error", error => { console.error(error.message); server.close(); process.exitCode = 1; });
chrome.once("exit", () => server.close());
function retain() {
  console.log(`Proof listener closed; testing browser and profile retained: ${directory}`);
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.once("SIGINT", retain);
process.once("SIGTERM", retain);
