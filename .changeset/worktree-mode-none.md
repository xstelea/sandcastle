---
"@ai-hero/sandcastle": minor
---

Add `{ mode: 'none' }` worktree variant that bind-mounts the host working directory directly into the sandbox container. No worktree is created, pruned, or cleaned up, and no merge step runs after iterations complete. Commits go directly onto the host's checked-out branch. `copyToSandbox` throws a runtime error with `mode: 'none'`. Both `SOURCE_BRANCH` and `TARGET_BRANCH` built-in prompt arguments resolve to the host's current branch.
