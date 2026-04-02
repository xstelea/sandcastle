---
"@ai-hero/sandcastle": patch
---

Add pi as a supported agent provider. `pi(model)` factory function is exported from `@ai-hero/sandcastle`. Pi's `--mode json` JSONL output is parsed correctly (message_update, tool_execution_start, agent_end events). `sandcastle init --agent pi` scaffolds a working setup with pi's Dockerfile and correct `main.ts`. `sandcastle interactive --agent pi` launches an interactive pi session.
