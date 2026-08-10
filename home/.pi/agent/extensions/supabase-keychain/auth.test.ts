import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveSupabaseAccessToken } from "./auth.js"

describe("resolveSupabaseAccessToken", () => {
  it("preserves an explicitly supplied environment token", () => {
    let keychainRead = false

    const resolution = resolveSupabaseAccessToken(
      { SUPABASE_ACCESS_TOKEN: "  sbp_environment_test  " },
      () => {
        keychainRead = true
        return "sbp_keychain_test"
      },
    )

    assert.deepEqual(resolution, {
      source: "environment",
      token: "sbp_environment_test",
    })
    assert.equal(keychainRead, false)
  })

  it("loads and trims the persistent Supabase CLI Keychain token", () => {
    const resolution = resolveSupabaseAccessToken(
      {},
      () => "  sbp_keychain_test\n",
    )

    assert.deepEqual(resolution, {
      source: "keychain",
      token: "sbp_keychain_test",
    })
  })

  it("fails closed when the Keychain token is empty", () => {
    assert.throws(
      () => resolveSupabaseAccessToken({}, () => "  \n"),
      /Keychain token is empty/,
    )
  })
})
