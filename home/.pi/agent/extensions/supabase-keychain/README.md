# Pi Supabase Keychain authentication

This extension loads `SUPABASE_ACCESS_TOKEN` into the Pi process from the macOS login Keychain.
The Keychain item uses service `Arena Supabase MCP` and account `SUPABASE_ACCESS_TOKEN`.
An explicitly supplied environment value takes precedence.
The token is never stored in Pi JSON configuration or this repository.

`~/.pi/agent/mcp.json` passes the environment variable to `pi-mcp-adapter` through `bearerTokenEnv`.
The `supabase-staging` and `supabase-production` servers are separately project-scoped, lazy, and proxy-only.
Staging is read-only, while production permits SQL writes through `execute_sql` for explicitly authorized operations.
Both servers reuse the same account-level PAT from the Keychain.
Migration, deployment, branch, and Edge Function mutation tools remain excluded from both adapter surfaces as defense in depth.
After changing `mcp.json`, restart Pi or run `/reload` because reconnecting an already loaded server does not reload its URL.

Run the focused tests from the dotfiles repository:

```sh
bun test ./home/.pi/agent/extensions/supabase-keychain/auth.test.ts
```
