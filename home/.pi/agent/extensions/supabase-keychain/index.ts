import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { resolveSupabaseAccessToken } from "./auth.js"

const TOKEN_ENV_NAME = "SUPABASE_ACCESS_TOKEN"
const STATUS_ID = "supabase-mcp-auth"

export default function supabaseKeychainExtension(pi: ExtensionAPI): void {
  const previousToken = process.env[TOKEN_ENV_NAME]
  let installedToken: string | undefined
  let initializationFailed = false

  try {
    const resolution = resolveSupabaseAccessToken()
    installedToken = resolution.token
    process.env[TOKEN_ENV_NAME] = resolution.token
  } catch {
    initializationFailed = true
  }

  pi.on("session_start", (_event, ctx) => {
    if (initializationFailed) {
      ctx.ui.setStatus(STATUS_ID, "Supabase MCP: PAT unavailable")
      ctx.ui.notify(
        "Supabase MCP authentication is unavailable because the Supabase CLI Keychain token could not be loaded.",
        "error",
      )
      return
    }

    ctx.ui.setStatus(STATUS_ID, "Supabase MCP: PAT ready")
  })

  pi.on("session_shutdown", (_event, ctx) => {
    if (
      installedToken !== undefined &&
      process.env[TOKEN_ENV_NAME] === installedToken
    ) {
      if (previousToken === undefined) {
        delete process.env[TOKEN_ENV_NAME]
      } else {
        process.env[TOKEN_ENV_NAME] = previousToken
      }
    }
    ctx.ui.setStatus(STATUS_ID, undefined)
  })
}
