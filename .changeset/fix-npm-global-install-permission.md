---
"@ai-hero/sandcastle": patch
---

Fixed npm global install permission error in PI and Codex agent Dockerfiles by running `npm install -g` as root before switching to the `agent` user.
