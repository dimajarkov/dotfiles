# Issue #15 Herdr feasibility gate result

Research date: 2026-10-10.

Scope: mandatory Herdr feasibility gate #15 for spec #35, using existing supported interfaces only.

**Result: NOT PASSED. Keep dependent integration blocked.**

## Decision

The earlier observer-only conclusion was too broad because Herdr 0.9.3 includes a stable endpoint protocol for client-owned shell surfaces.
That is a genuine seam for a deliberately launched client-owned shell and cooperating requests that use that endpoint lane.

It does not establish a supported relay for the installed same-install direct-terminal client, nor exclusive mediation of Herdr's separate public API socket.
No supported operation was found to transfer an already-connected direct-terminal client's connection, identity, or input/navigation stream into a helper's serialization boundary.

A helper may be worth exploring for clients that are intentionally created to use the client-shell endpoint contract.
That possibility is not a complete mediation mechanism for the existing direct-terminal UI and public API callers, and it does not pass the required attachment-ownership and race criteria.
This conclusion is limited to the inspected Herdr 0.9.3 interfaces, not all possible future versions or topologies.

## Findings

| Requirement | Result | Evidence and limit |
| --- | --- | --- |
| Use the client-owned-shell protocol | Partial seam exists | The pinned source calls endpoint generation 1 the stable compatibility contract for client-owned shells and explicitly distinguishes it from the private same-install CLI, direct-terminal, and handoff protocol. |
| Mediate participating shell operations | Candidate only | The client-shell lane carries endpoint requests, and its allowlist includes operations such as `pane.focus`, `pane.zoom`, and `pane.close`. This shows what a participating shell connection can request, not that all clients use the lane or that a supported relay implementation already exists. |
| Mediate the existing direct-terminal client | Not established | When the client has a shell surface, the handshake selects endpoint generation 1. Without that shell surface, it sends the private `TerminalHello` handshake. The endpoint compatibility contract is explicitly separate from that private direct-terminal protocol. |
| Force every API mutation through a helper | Not established | Herdr binds a local public JSON API listener separately from its client-shell listener. `HERDR_SOCKET_PATH` chooses a socket path and derives the client-shell path; it does not require exclusive proxy routing or prevent another caller from connecting directly. |
| Adopt an existing direct-terminal connection | No supported operation found | The endpoint handshake is selected when a connection is established. No supported rebind or transfer operation was found for an already-connected direct-terminal client. Setting a socket override for a later process does not adopt the existing connection, and an explicit session selection takes precedence over the inherited override. |
| Prove ownership, navigation, and race acceptance | Not performed | No implementation, disposable Herdr server/client, live session, pane mutation, runtime race, or physical-key test was run. A helper that mediates only cooperating shell/API callers cannot prove races involving direct-terminal input or other callers that bypass it. |

## Version-pinned primary evidence

Static source evidence is Herdr 0.9.3 at upstream commit [`7b116c05bfda646af39d2524c54e70c751f57ee8`](https://github.com/herdrdev/herdr/tree/7b116c05bfda646af39d2524c54e70c751f57ee8), API protocol 22, schema version 1.
The installed version was previously verified with `herdr --version`, and the installed schema was obtained with `herdr api schema --json` after confirming `HERDR_ENV=1`.

- [`src/protocol/endpoint.rs` lines 1-10](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/protocol/endpoint.rs#L1-L10) defines generation 1 as the stable client-owned-shell contract and distinguishes the private same-install CLI, direct-terminal, and handoff protocol.
- [`src/client/handshake.rs` lines 177-221](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/client/handshake.rs#L177-L221) selects the endpoint hello when a shell surface exists and the private `TerminalHello` otherwise.
- [`src/server/client_commands.rs` lines 15-56](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/server/client_commands.rs#L15-L56) lists the operations allowed on the client-shell endpoint lane.
- [`src/protocol/wire.rs` lines 613-615](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/protocol/wire.rs#L613-L615) defines endpoint operations as requests through the client shell's selected connection.
- [`src/api/server.rs` lines 80-91](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/server.rs#L80-L91) binds the public API listener, while [`src/server/headless/lifecycle.rs` lines 253-257](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/server/headless/lifecycle.rs#L253-L257) binds the client listener separately.
- [`src/server/socket_paths.rs` lines 10-48](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/server/socket_paths.rs#L10-L48) describes socket overrides as path selection and derives the client socket path; it does not enforce use of a proxy.
- [`src/session.rs` lines 168-183](https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/session.rs#L168-L183) gives explicit session selection precedence over the inherited API socket override.

These sources establish a client-owned-shell seam and a separate direct-terminal path.
They do not establish endpoint relay adoption, mandatory proxy enforcement, or a server-enforced ownership/generation condition for pane closure.

## Gate consequence

The client-owned-shell endpoint corrects the earlier overbroad claim that no supported shell mediation seam exists.
It does not meet the gate's requirement to serialize or conservatively refuse concurrent direct entry, replacement, repurposing, and close operations when those actions can bypass the helper.
The required targeting, visit, original-master, and protected-close invariants therefore remain unproven.

Do not unlock dependent issue #35 integration from this result.
Revisit the gate only if a supported mechanism can make the relevant existing client and public API traffic exclusively participate in one serialization boundary, or if the approved requirements are explicitly revised.
Do not infer complete mediation from a proxy-shaped socket override, a second client, private wire decoding, observer timing, or a controller-local lock.

## Investigation boundary

Only read-only help, version, schema, and version-pinned source inspection were used.
No live-session inventory or request, pane mutation, Herdr configuration change, implementation, disposable process/socket/session, model launch, or physical-key proof was performed.
No runtime resource was created, so there are no cleanup receipts.
