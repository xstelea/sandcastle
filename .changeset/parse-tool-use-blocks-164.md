---
"@ai-hero/sandcastle": patch
---

Parse tool_use blocks from Claude Code stream-json (issue #164)

`parseStreamJsonLine` now returns an array of events per line instead of a single
nullable result. Each assistant event may produce `text` and/or `tool_call` items
when content blocks contain both types. The `tool_call` variant includes the tool
`name` and full `input` object.
