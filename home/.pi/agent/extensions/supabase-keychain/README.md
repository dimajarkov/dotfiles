# Pi Supabase Keychain authentication

This extension loads `SUPABASE_ACCESS_TOKEN` into the Pi process from the macOS login Keychain.
The Keychain item uses service `Arena Supabase MCP` and account `SUPABASE_ACCESS_TOKEN`.
An explicitly supplied environment value takes precedence.
The token is never stored in Pi JSON configuration or this repository.

`~/.pi/agent/mcp.json` passes the environment variable to `pi-mcp-adapter` through `bearerTokenEnv`.
The `supabase-staging` and `supabase-production` servers are separately project-scoped, read-only, lazy, and proxy-only.
Both servers reuse the same account-level PAT from the Keychain.
Known mutating tools are excluded from both adapter surfaces as defense in depth.

Run the focused tests from the dotfiles repository:

```sh
bun test ./home/.pi/agent/extensions/supabase-keychain/auth.test.ts
```
