---
name: signalhouse-mcp
description: Use when inspecting, debugging, or operating SignalHouse through the globally configured SignalHouse MCP server, including messaging, A2P groups, subgroups, brands, campaigns, numbers, SMS, MMS, delivery setup, or onboarding.
---

# SignalHouse MCP

Use Pi's global `signalhouse` MCP server through the `mcp` tool.
Never invoke another agent harness or start a nested agent session.

## Safety boundary

- Default to read-only inspection.
- Treat every SignalHouse operation as a live provider operation unless an isolated mock is proven.
- Never send messages, purchase numbers, or create, update, delete, appeal, or nudge provider resources without an explicit request for that exact mutation.
- Never print secrets, bearer tokens, full environments, raw customer phone lists, full message bodies, or raw provider payloads.
- Mask phone numbers and return only the minimum non-secret fields needed.
- Use the globally configured `dev` Infisical source by default.

## Startup

1. Connect with `mcp({ connect: "signalhouse" })` when needed.
2. Search or list the server tools through `mcp` rather than guessing tool names.
3. Call `get_documentation` first.
4. Call `list_groups` second.
5. Call `list_subgroups` for the selected group before continuing.

## Read-only workflows

For inventory, continue with the narrowest relevant calls to list brands, campaigns, or numbers.
For registration status, list brands before requesting brand or appeal status.
For campaign status, list campaigns before requesting campaign status and assigned numbers.
For messaging readiness, verify number ownership, campaign assignment, and an active campaign before considering a send.

## Mutations

Before a requested mutation, state the target environment, exact MCP tool, target resource, fields sent, and fields returned.
Check for duplicates and current status first.
Require exact targets and payload fields from the user or a trusted source.
Keep remote outcomes distinct as rejected, accepted but unconfirmed, confirmed, or inconclusive.

## Result

Report the server, non-secret target identifiers, status, minimal evidence, writes performed, and any blocker.
State that no secrets were printed.
