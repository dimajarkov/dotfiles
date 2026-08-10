import { execFileSync } from "node:child_process"

const KEYCHAIN_ACCOUNT = "SUPABASE_ACCESS_TOKEN"
const KEYCHAIN_SERVICE = "Arena Supabase MCP"
const TOKEN_ENV_NAME = "SUPABASE_ACCESS_TOKEN"

type Environment = Record<string, string | undefined>
type KeychainReader = () => string

export type SupabaseTokenResolution = {
  source: "environment" | "keychain"
  token: string
}

export function readSupabaseCliTokenFromKeychain(): string {
  return execFileSync(
    "/usr/bin/security",
    [
      "find-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-w",
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  )
}

export function resolveSupabaseAccessToken(
  environment: Environment = process.env,
  readKeychain: KeychainReader = readSupabaseCliTokenFromKeychain,
): SupabaseTokenResolution {
  const environmentToken = environment[TOKEN_ENV_NAME]?.trim()
  if (environmentToken) {
    return { source: "environment", token: environmentToken }
  }

  const keychainToken = readKeychain().trim()
  if (!keychainToken) {
    throw new Error("Supabase CLI Keychain token is empty")
  }

  return { source: "keychain", token: keychainToken }
}
