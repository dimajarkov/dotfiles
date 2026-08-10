import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export const COMPOSIO_KEYCHAIN_SERVICE = "pi-composio-api-key";

interface ResolveComposioApiKeyOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  account?: string;
  apiKeyFile?: string;
  readApiKeyFile?: (path: string) => string | undefined;
  readKeychain?: (account: string) => string | undefined;
}

function readApiKeyFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function readMacOSKeychain(account: string): string | undefined {
  try {
    const value = execFileSync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-w",
        "-a",
        account,
        "-s",
        COMPOSIO_KEYCHAIN_SERVICE,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function resolveComposioApiKey(
  options: ResolveComposioApiKeyOptions = {},
): string | undefined {
  const environmentValue = (options.environment ?? process.env).COMPOSIO_API_KEY?.trim();
  if (environmentValue) return environmentValue;

  const apiKeyFile =
    options.apiKeyFile ??
    (options.environment ?? process.env).COMPOSIO_API_KEY_FILE ??
    join(homedir(), ".config", "pi-composio", "api-key");
  const fileValue = (options.readApiKeyFile ?? readApiKeyFile)(apiKeyFile)?.trim();
  if (fileValue) return fileValue;

  if ((options.platform ?? process.platform) !== "darwin") return undefined;
  const account = options.account ?? userInfo().username;
  return (options.readKeychain ?? readMacOSKeychain)(account)?.trim() || undefined;
}
