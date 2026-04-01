# @ai-hero/sandcastle

## 0.1.8

### Patch Changes

- 783b4cd: Base worktree cleanup on uncommitted changes rather than run success/failure.

  Previously, worktrees were always preserved on failure and always removed on success. Now the decision is based on whether the worktree has uncommitted changes (unstaged modifications, staged changes, or untracked files):
  - Success + clean worktree: remove silently (same as before)
  - Success + dirty worktree: preserve and print "uncommitted changes" message
  - Failure + clean worktree: remove and print "no uncommitted changes" message
  - Failure + dirty worktree: preserve with current preservation message

  `RunResult` now includes an optional `preservedWorktreePath` field set when a successful run leaves a worktree behind due to uncommitted changes. `TimeoutError.preservedWorktreePath` and `AgentError.preservedWorktreePath` are only set when the worktree is actually preserved (dirty), not on every failure.

## 0.1.7

### Patch Changes

- 5eef716: Inject `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` as built-in prompt arguments. These are available in any prompt without passing them via `promptArgs`. Passing either key in `promptArgs` now fails with an error.
- 78ef034: Fix sandbox crash on macOS by setting `HOME=/home/agent` in the container environment. Previously, Docker's `--user` flag caused `HOME` to default to `/`, making `git config --global` fail with a permission error on `//.gitconfig`.
- fed9a66: Replace wall-clock timeout with idle-based timeout that resets on each agent output event.
  - Rename `timeoutSeconds` → `idleTimeoutSeconds` in `RunOptions` and `OrchestrateOptions`
  - Change default from 1200s (20 min) to 300s (5 min)
  - Timeout now tracks from last received message (text or tool call), not run start
  - Error message updated to: "Agent idle for N seconds — no output received. Consider increasing the idle timeout with --idle-timeout."

- b16e0e0: Support multiple completion signals via `completionSignal: string | string[]`. The result field `wasCompletionSignalDetected: boolean` is replaced by `completionSignal?: string` — the matched signal string, or `undefined` if none fired.
- 0f48ef8: Preserve worktree on failure (timeout, agent error, SIGINT, SIGTERM)

  When a run session ends in failure, the sandbox (Docker container) is removed but the
  worktree is now preserved on the host. A message is printed with the worktree path and
  manual cleanup instructions. On successful completion, both the sandbox and worktree
  are removed as before.

  `TimeoutError` and `AgentError` now carry an optional `preservedWorktreePath` field
  so programmatic callers can inspect or build on the preserved worktree.

## 0.1.6

### Patch Changes

- 1cd8bdb: Remove single-branch shortcut in parallel-planner template; always use the merge agent

## 0.1.5

### Patch Changes

- 1cd8bdb: Close GitHub issue when single-branch merge is performed directly in parallel-planner template

## 0.1.4

### Patch Changes

- 8e08f7e: Document custom completion signal in the Early termination README section
- 6f9d3be: Fix CLI option tables to show correct default `--image-name` as `sandcastle:<repo-dir-name>` instead of `sandcastle:local`
- 4c94c5f: Fix README incorrectly describing `.sandcastle/prompt.md` as a default for `promptFile`. Neither `prompt` nor `promptFile` has a default — omitting both causes an error. The `.sandcastle/prompt.md` path is a convention scaffolded by `sandcastle init`, not an automatic fallback.
- 0d93587: Include run name in log filename to prevent overwrites in multi-agent workflows. When `name` is passed to `run()`, it is appended to the log filename (e.g. `main-implementer.log` instead of `main.log`).
- 26683b5: Lead the API section with a simple run() example before the full options reference.
- 3e32b7b: Remove `sandcastle interactive` CLI command documentation from README
- 762642e: Remove stale `patches/` entry from scaffolded `.sandcastle/.gitignore`. Nothing in Sandcastle creates a `.sandcastle/patches/` directory — the worktree-based architecture eliminated patch-based sync.

## 0.1.3

### Patch Changes

- 8b43a04: Remove pnpm/corepack from default sandbox Dockerfile template. The base Node.js image already includes npm, so the `corepack enable` step is unnecessary overhead. All init templates now use `npm install` and `npm run` instead of pnpm equivalents.
- 925506d: Replace pnpm with npm in README documentation
- 74b3f3b: Replace pnpm with npm in scaffold templates. All generated prompt files and main.ts hooks now use `npm install` and `npm run` instead of pnpm, consistent with the project's migration to npm.

## 0.1.2

### Patch Changes

- 3ece5cb: Removed unused `mkdir -p /home/agent/repos` from Dockerfile template. The workspace is bind-mounted at `/home/agent/workspace`, so this directory was never used.

## 0.1.1

### Patch Changes

- 0f61f59: Filter issue lists by `Sandcastle` label in all templates. `sandcastle init` now offers to create the label on the repo.

## 0.1.0

### Minor Changes

- a5cff39: Hide `agent` option from public API. The `agent` field has been removed from `RunOptions` and the `--agent` CLI flag has been removed from `init` and `interactive` commands. Agent selection is now hardcoded to `claude-code` internally. The agent provider system remains as an internal implementation detail.

### Patch Changes

- f11fd90: Add JSDoc comments to all public-facing type properties: `RunResult`, `LoggingOption`, and `PromptArgs`.
- 1fc5e32: Add kitchen-sink `run()` example to README with inline JSDoc-style comments on every option. Also updates the `RunOptions` table to remove the hidden `agent` field, fix the `maxIterations` default (1, not 5), fix the `timeoutSeconds` default (1200, not 900), update the `imageName` default, and add the missing `name` and `copyToSandbox` fields. Removes the removed `--agent` flag from the `sandcastle init` and `sandcastle interactive` CLI tables.
- b713226: Migrate from npm to pnpm across the project (issue #168).
  - Added `packageManager: "pnpm@10.7.0"` to `package.json`
  - Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
  - Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
  - Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
  - Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
  - Updated `README.md` development and hooks examples to use pnpm
  - Updated `InitService.ts` next-steps text to reference pnpm

- cd429c0: Replace --ff-only with regular merge for worktree merge-back (issue #162)

  When the agent finishes, Sandcastle now uses `git merge` instead of `git merge --ff-only` to integrate the temp branch back into the host branch. This allows users to make commits on the host branch while Sandcastle is running without causing merge-back failures. Fast-forward still happens naturally when the host branch hasn't moved; only the requirement that it _must_ fast-forward is removed.

- db3adec: Show run name instead of provider name in log-to-file summary (issue #160).

  When `name` is passed to `run()`, it now appears as the `Agent` value in the run summary instead of the internal provider name (`claude-code`). When no name is provided the provider name is used as before.

- df9fe6c: Surface tool calls in run logs (issues #163, #164, #165, #166).

  `parseStreamJsonLine` now returns an array of events per line. Assistant messages may produce `text` and/or `tool_call` items. Tool calls are filtered to an allowlist (Bash, WebSearch, WebFetch, Agent) with per-tool arg extraction, and displayed interleaved with agent text output. The Display service gains a `toolCall(name, formattedArgs)` method rendered as a dim-styled step in terminal mode and a plain log line in log-to-file mode.

- dbe5989: Update 'How it works' section in README to describe the worktree-based architecture, replacing the outdated sync-in/sync-out description. Also fix related references to sync-in/sync-out throughout the README.
