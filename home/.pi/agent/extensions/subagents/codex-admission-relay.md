# Codex admission policy prototype

Status: exploratory policy model only; this is not a Codex relay or supported deployment topology.

Run its unit tests with `npm run test:admission` from this directory.

The tests exercise reservation races, journal recovery, pause-barrier release, manager-owned queue staging, default-deny route classification, and a single in-memory responder owner.

The journal test covers sequential authority recreation only; it does not provide cross-process locking or prove durable admission in a running Codex host.

A separate isolated Codex 0.160.1 stdio probe showed that direct native `turn/start` and `thread/queue/add` calls can dispatch to a local fixture without an external admission decision, and that two concurrent native starts both dispatched.

That probe establishes bypass when callers reach the unguarded host directly; it does not establish whether a sole-owner relay can safely mediate every route and internal continuation.

No authenticated Unix WebSocket relay, Codex host mediation, effective built-in tool restriction, goal quiescence, or single-responder runtime behavior has been verified.

The in-memory responder test replays a pending question after the same controller identity reconnects; it does not verify relay reconnection or delivery against a live host.

No real model request to `gpt-6-luna` at `xhigh` was made; fixture results are not real-model evidence.

The topology and gate status remain unproven, and these tests do not constitute a pass or a global impossibility finding.
