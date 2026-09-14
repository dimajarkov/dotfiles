---
description: Asynchronously implement, review, and apply feedback with persistent Herdr agents
---
Start an asynchronous three-stage Herdr subagent workflow for: $@

Choose one concise workflow slug that is unique among the current session's subagents.
Pass that same slug as `workScope` on every spawn in this workflow so related agents share one master Herdr tab in this conversation.
Spawn a worker named `<slug>-implementation` to implement and validate the request.
Do not block or poll while it works.
When its completion message arrives, spawn a reviewer named `<slug>-review` to review the actual resulting working-tree changes against the request and repository standards.
When the reviewer completes, spawn a worker named `<slug>-fixes` with the original request, implementation result, and review findings so it can apply required fixes and rerun validation.
When the final worker completes, inspect the result and report the implemented outcome, review resolution, and validation to the user.
