import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface ComposioExtensionConfig {
  userId: string;
  toolkits?: string[];
  sandbox: boolean;
  callbackUrl?: string;
}

interface ConfigFile {
  userId?: unknown;
  toolkits?: unknown;
  sandbox?: unknown;
  callbackUrl?: unknown;
}

const CONFIG_KEYS = new Set(["userId", "toolkits", "sandbox", "callbackUrl"]);

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseConfigFile(value: unknown): Partial<ComposioExtensionConfig> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be a JSON object");
  }

  const config = value as ConfigFile & Record<string, unknown>;
  const unknownKeys = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`unknown config ${unknownKeys.length === 1 ? "key" : "keys"}: ${unknownKeys.join(", ")}`);
  }

  let toolkits: string[] | undefined;
  if (config.toolkits !== undefined) {
    if (
      !Array.isArray(config.toolkits) ||
      config.toolkits.some((toolkit) => typeof toolkit !== "string" || toolkit.trim() === "")
    ) {
      throw new Error("toolkits must be an array of non-empty strings");
    }
    toolkits = [...new Set(config.toolkits.map((toolkit) => toolkit.trim().toLowerCase()))];
  }

  if (config.sandbox !== undefined && typeof config.sandbox !== "boolean") {
    throw new Error("sandbox must be a boolean");
  }

  return {
    userId: optionalString(config.userId, "userId"),
    toolkits,
    sandbox: config.sandbox as boolean | undefined,
    callbackUrl: optionalString(config.callbackUrl, "callbackUrl"),
  };
}

export function loadComposioConfig(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): ComposioExtensionConfig {
  const configPath = env.COMPOSIO_CONFIG_PATH ?? join(homeDirectory, ".config", "pi-composio", "config.json");
  let fileConfig: Partial<ComposioExtensionConfig> = {};

  try {
    fileConfig = parseConfigFile(JSON.parse(readFileSync(configPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid Composio config at ${configPath}: ${message}`);
    }
  }

  const environmentUserId = env.COMPOSIO_USER_ID?.trim();
  const userId = environmentUserId || fileConfig.userId || `pi:${userInfo().username}`;

  return {
    userId,
    toolkits: fileConfig.toolkits,
    sandbox: fileConfig.sandbox ?? true,
    callbackUrl: fileConfig.callbackUrl,
  };
}
