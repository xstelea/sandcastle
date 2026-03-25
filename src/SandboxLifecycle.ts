import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Effect } from "effect";
import type { SandcastleConfig } from "./Config.js";
import { Display } from "./Display.js";
import { SyncError, type SandboxError } from "./errors.js";
import { Sandbox, type SandboxService } from "./Sandbox.js";
import { execOk, syncIn, syncOut } from "./SyncService.js";

const execAsync = promisify(exec);

export interface SandboxLifecycleOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly hooks?: SandcastleConfig["hooks"];
  readonly branch?: string;
  /** When true, skip sync-in and sync-out (worktree mode: repo is bind-mounted directly). */
  readonly skipSync?: boolean;
  /** Host-side path to the worktree directory. Required in worktree mode when sandboxRepoDir
   *  is a container path that doesn't exist on the host (e.g. /home/agent/workspace). */
  readonly hostWorktreePath?: string;
}

export interface SandboxContext {
  readonly sandbox: SandboxService;
  readonly sandboxRepoDir: string;
  readonly baseHead: string;
}

export interface SandboxLifecycleResult<A> {
  readonly result: A;
  readonly branch: string;
  readonly commits: { sha: string }[];
}

export const withSandboxLifecycle = <A>(
  options: SandboxLifecycleOptions,
  work: (
    ctx: SandboxContext,
  ) => Effect.Effect<A, SandboxError, Sandbox | Display>,
): Effect.Effect<SandboxLifecycleResult<A>, SandboxError, Sandbox | Display> =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const display = yield* Display;
    const {
      hostRepoDir,
      sandboxRepoDir,
      hooks,
      branch,
      skipSync,
      hostWorktreePath,
    } = options;

    // In worktree mode with no explicit branch, record host's current branch for cherry-pick
    const hostCurrentBranch: string | null =
      skipSync && !branch
        ? yield* Effect.promise(async () => {
            const { stdout } = await execAsync(
              "git rev-parse --abbrev-ref HEAD",
              { cwd: hostRepoDir },
            );
            return stdout.trim();
          })
        : null;

    // Setup: sync-in (isolated mode only), onSandboxReady hooks
    let resolvedBranch = "";
    yield* display.taskLog("Setting up sandbox", (message) =>
      Effect.gen(function* () {
        if (skipSync) {
          // Worktree mode: the bind-mounted worktree may be owned by a
          // different UID (host user vs container user).  Mark it safe so
          // git doesn't reject it with "dubious ownership".
          yield* execOk(
            sandbox,
            `git config --global --add safe.directory "${sandboxRepoDir}"`,
          );

          // Worktree mode: repo is bind-mounted — discover branch directly
          resolvedBranch = (yield* execOk(
            sandbox,
            "git rev-parse --abbrev-ref HEAD",
            { cwd: sandboxRepoDir },
          )).stdout.trim();
        } else {
          message("Syncing repo into sandbox");
          const syncResult = yield* syncIn(
            hostRepoDir,
            sandboxRepoDir,
            branch ? { branch } : undefined,
          );
          resolvedBranch = syncResult.branch;
        }

        if (hooks?.onSandboxReady?.length) {
          for (const hook of hooks.onSandboxReady) {
            message(hook.command);
            yield* execOk(sandbox, hook.command, { cwd: sandboxRepoDir });
          }
        }
      }),
    );

    const targetBranch = branch ?? resolvedBranch;

    // Record base HEAD
    const baseHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
      cwd: sandboxRepoDir,
    })).stdout.trim();

    // Record HEAD on the target branch before sync-out (isolated mode only)
    const headBeforeSyncOut = skipSync
      ? null
      : yield* Effect.promise(async () => {
          try {
            const { stdout } = await execAsync(
              `git rev-parse --verify "refs/heads/${targetBranch}"`,
              { cwd: hostRepoDir },
            );
            return stdout.trim();
          } catch {
            // Branch doesn't exist on host yet — will be created during sync-out
            return null;
          }
        });

    // Run the caller's work
    const result = yield* work({ sandbox, sandboxRepoDir, baseHead });

    if (!skipSync) {
      // Sync-out — only show spinner if there are commits to sync
      const currentHead = (yield* execOk(sandbox, "git rev-parse HEAD", {
        cwd: sandboxRepoDir,
      })).stdout.trim();

      const syncOutEffect = syncOut(
        hostRepoDir,
        sandboxRepoDir,
        baseHead,
        branch ? { branch } : undefined,
      );

      if (currentHead !== baseHead) {
        const commitCountResult = yield* execOk(
          sandbox,
          `git rev-list "${baseHead}..HEAD" --count`,
          { cwd: sandboxRepoDir },
        );
        const commitCount = parseInt(commitCountResult.stdout.trim(), 10);
        const syncMessage = `Syncing ${commitCount} ${commitCount === 1 ? "commit" : "commits"} back to host`;
        yield* display.spinner(syncMessage, syncOutEffect);
      } else {
        yield* syncOutEffect;
      }
    }

    // Collect commits and handle cherry-pick for temp branches
    let commits: { sha: string }[];
    let finalBranch: string;

    // For host-side git operations in worktree mode, use hostWorktreePath
    // (the real path on the host) instead of sandboxRepoDir (which may be a container path
    // like /home/agent/workspace that doesn't exist on the host).
    const hostSideWorktreePath = hostWorktreePath ?? sandboxRepoDir;

    if (hostCurrentBranch !== null) {
      // Temp branch mode: collect worktree commits, detach, cherry-pick, delete branch

      // Collect SHAs from the temp branch (since baseHead)
      const tempShas = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --reverse`,
            { cwd: hostSideWorktreePath },
          );
          const lines = stdout.trim();
          if (!lines) return [];
          return lines.split("\n");
        } catch {
          return [] as string[];
        }
      });

      // Detach the worktree from the temp branch so the branch can be deleted
      yield* execOk(sandbox, "git checkout --detach", { cwd: sandboxRepoDir });

      if (tempShas.length > 0) {
        // Cherry-pick commits onto host's current branch
        yield* Effect.tryPromise({
          try: async () => {
            try {
              await execAsync(`git cherry-pick ${tempShas.join(" ")}`, {
                cwd: hostRepoDir,
              });
            } catch {
              await execAsync("git cherry-pick --abort", {
                cwd: hostRepoDir,
              }).catch(() => {});
              throw new Error(
                `Cherry-pick of ${tempShas.length} commit(s) onto '${hostCurrentBranch}' failed. ` +
                  `The temporary branch '${resolvedBranch}' has been preserved. ` +
                  `To retry: git cherry-pick ${tempShas.join(" ")}, ` +
                  `then clean up: git branch -D ${resolvedBranch}`,
              );
            }
          },
          catch: (e) =>
            new SyncError({
              message: String(e instanceof Error ? e.message : e),
            }),
        });
      }

      // Force-delete the temp branch (cherry-picked commits have new SHAs on host)
      yield* Effect.promise(() =>
        execAsync(`git branch -D "${resolvedBranch}"`, {
          cwd: hostRepoDir,
        }).catch(() => {}),
      );

      // Collect the cherry-picked commits now on the host branch
      commits = yield* Effect.promise(async () => {
        try {
          const { stdout } = await execAsync(
            `git rev-list "${baseHead}..HEAD" --reverse`,
            { cwd: hostRepoDir },
          );
          const lines = stdout.trim();
          if (!lines) return [];
          return lines.split("\n").map((sha) => ({ sha }));
        } catch {
          return [];
        }
      });

      finalBranch = hostCurrentBranch;
    } else {
      // Isolated mode or explicit branch in worktree mode: existing behavior
      commits = yield* Effect.promise(async () => {
        // In isolated mode, use headBeforeSyncOut to capture only sync-out commits.
        // In worktree mode with explicit branch, use baseHead.
        const rangeStart = headBeforeSyncOut ?? baseHead;
        try {
          const { stdout } = await execAsync(
            `git rev-list "${rangeStart}..refs/heads/${targetBranch}" --reverse`,
            { cwd: hostRepoDir },
          );
          const lines = stdout.trim();
          if (!lines) return [];
          return lines.split("\n").map((sha) => ({ sha }));
        } catch {
          // Branch doesn't exist on host (no commits were produced)
          return [];
        }
      });

      finalBranch = targetBranch;
    }

    return { result, branch: finalBranch, commits };
  });
