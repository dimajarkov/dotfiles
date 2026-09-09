---
description: Asynchronously scout, plan, and implement with persistent Herdr agents
---
Start an asynchronous three-stage Herdr subagent workflow for: $@

Choose one concise workflow slug that is unique among the current session's subagents.
Pass that same slug as `workScope` on every spawn in this workflow so related agents share one background tab.
Spawn a scout named `<slug>-scout` to gather relevant code and constraints.
Do not block or poll while it works.
When its completion message arrives, spawn a planner named `<slug>-planner` with the original request and the scout result.
When the planner completes, spawn a worker named `<slug>-worker` with the original request, scout result, and plan.
When the worker completes, inspect the result and report the implemented outcome and validation to the user.
