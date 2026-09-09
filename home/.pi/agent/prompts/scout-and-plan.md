---
description: Asynchronously scout and plan with persistent Herdr agents
---
Start an asynchronous two-stage Herdr subagent workflow for: $@

Choose one concise workflow slug that is unique among the current session's subagents.
Pass that same slug as `workScope` on every spawn in this workflow so related agents share one background tab.
Spawn a scout named `<slug>-scout` to gather relevant code and constraints.
Do not block or poll while it works.
When its completion message arrives, spawn a planner named `<slug>-planner` with the original request and scout result.
When the planner completes, report the plan to the user without implementing it.
