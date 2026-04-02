---
"@ai-hero/sandcastle": patch
---

Use run name instead of agent name in worktree and branch naming. When a `name` is provided to `run()`, worktree directories and temp branches now include the run name (e.g. `sandcastle/<name>/<timestamp>`) instead of the agent provider name. Renamed `sanitizeAgentName` to `sanitizeName`.
