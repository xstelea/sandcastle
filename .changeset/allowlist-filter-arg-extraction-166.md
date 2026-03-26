---
"@ai-hero/sandcastle": patch
---

Add allowlist filter and per-tool arg extraction for tool calls (issue #166).

`parseStreamJsonLine` now filters tool_use blocks by an allowlist (Bash, WebSearch, WebFetch, Agent) and extracts the display arg per tool. The `tool_call` event shape changes from `{ name, input }` to `{ name, args }`. The orchestrator wires tool calls to `display.toolCall()` in real time.
