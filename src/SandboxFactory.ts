import { Context, Effect, Layer } from "effect";
import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  startContainer,
  removeContainer,
  chownInContainer,
} from "./DockerLifecycle.js";
import {
  CopyError,
  ExecError,
  type DockerError,
  type WorktreeError,
} from "./errors.js";
import * as WorktreeManager from "./WorktreeManager.js";
import { copyToSandbox } from "./CopyToSandbox.js";
import { Display } from "./Display.js";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly execStreaming: (
    command: string,
    onStdoutLine: (line: string) => void,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, ExecError>;

  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, CopyError>;

  readonly copyOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, CopyError>;
}

export class Sandbox extends Context.Tag("Sandbox")<
  Sandbox,
  SandboxService
>() {}

const makeDockerSandbox = (
  containerName: string,
): Effect.Effect<SandboxService, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      exec: (command, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          execFile(
            "docker",
            args,
            { maxBuffer: 10 * 1024 * 1024 },
            (error, stdout, stderr) => {
              if (error && error.code === undefined) {
                resume(
                  Effect.fail(
                    new ExecError({
                      command,
                      message: `docker exec failed: ${error.message}`,
                    }),
                  ),
                );
              } else {
                resume(
                  Effect.succeed({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode:
                      typeof error?.code === "number"
                        ? error.code
                        : (0 as number),
                  }),
                );
              }
            },
          );
        }),

      execStreaming: (command, onStdoutLine, options) =>
        Effect.async((resume) => {
          const args = ["exec"];
          if (options?.cwd) {
            args.push("-w", options.cwd);
          }
          args.push(containerName, "sh", "-c", command);

          const proc = spawn("docker", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });

          const stdoutChunks: string[] = [];
          const stderrChunks: string[] = [];

          const rl = createInterface({ input: proc.stdout! });
          rl.on("line", (line) => {
            stdoutChunks.push(line);
            onStdoutLine(line);
          });

          proc.stderr!.on("data", (chunk: Buffer) => {
            stderrChunks.push(chunk.toString());
          });

          proc.on("error", (error) => {
            resume(
              Effect.fail(
                new ExecError({
                  command,
                  message: `docker exec streaming failed: ${error.message}`,
                }),
              ),
            );
          });

          proc.on("close", (code) => {
            resume(
              Effect.succeed({
                stdout: stdoutChunks.join("\n"),
                stderr: stderrChunks.join(""),
                exitCode: code ?? 0,
              }),
            );
          });
        }),

      copyIn: (hostPath, sandboxPath) =>
        Effect.gen(function* () {
          const parentDir = dirname(sandboxPath);
          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["exec", containerName, "mkdir", "-p", parentDir],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to create dir ${parentDir}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", hostPath, `${containerName}:${sandboxPath}`],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${hostPath} -> ${containerName}:${sandboxPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),

      copyOut: (sandboxPath, hostPath) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(dirname(hostPath), { recursive: true }).pipe(
            Effect.mapError(
              (error) =>
                new CopyError({
                  message: `Failed to create host dir ${dirname(hostPath)}: ${error}`,
                }),
            ),
          );

          yield* Effect.async<void, CopyError>((resume) => {
            execFile(
              "docker",
              ["cp", `${containerName}:${sandboxPath}`, hostPath],
              (error) => {
                if (error) {
                  resume(
                    Effect.fail(
                      new CopyError({
                        message: `Failed to copy ${containerName}:${sandboxPath} -> ${hostPath}: ${error.message}`,
                      }),
                    ),
                  );
                } else {
                  resume(Effect.succeed(undefined));
                }
              },
            );
          });
        }),
    };
  });

const makeDockerSandboxLayer = (containerName: string): Layer.Layer<Sandbox> =>
  Layer.effect(Sandbox, makeDockerSandbox(containerName)).pipe(
    Layer.provide(NodeFileSystem.layer),
  );

/** The mount point inside the container where the project worktree is bound. */
export const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

export interface SandboxInfo {
  /** Host-side path to the worktree directory (worktree mode only). */
  readonly hostWorktreePath?: string;
}

export class SandboxFactory extends Context.Tag("SandboxFactory")<
  SandboxFactory,
  {
    readonly withSandbox: <A, E, R>(
      makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
    ) => Effect.Effect<A, E | DockerError | WorktreeError, Exclude<R, Sandbox>>;
  }
>() {}

/**
 * Synchronously force-remove a Docker container.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveContainerSync = (containerName: string): void => {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  } catch {
    // Best-effort — container may already be gone
  }
};

export class WorktreeSandboxConfig extends Context.Tag("WorktreeSandboxConfig")<
  WorktreeSandboxConfig,
  {
    readonly imageName: string;
    readonly env: Record<string, string>;
    readonly hostRepoDir: string;
    /** When specified, the worktree checks out this branch. Otherwise a temp branch is created. */
    readonly branch?: string;
    /** Paths relative to the host repo root to copy into the worktree before container start. */
    readonly copyToSandbox?: string[];
    /** When specified, the agent name is included in the auto-generated branch and worktree names. */
    readonly agentName?: string;
  }
>() {}

/**
 * Synchronously force-remove a git worktree.
 * Used in process exit handlers where async operations are not possible.
 */
const forceRemoveWorktreeSync = (
  worktreePath: string,
  repoDir: string,
): void => {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      stdio: "ignore",
      cwd: repoDir,
    });
  } catch {
    // Best-effort — worktree may already be gone
  }
};

/**
 * Worktree sandbox mode: creates a git worktree and bind-mounts it into the
 * container at SANDBOX_WORKSPACE_DIR. The host's .git directory is also bind-mounted at
 * its original host path so the worktree's .git file pointer resolves correctly.
 */
export const WorktreeDockerSandboxFactory = {
  layer: Layer.effect(
    SandboxFactory,
    Effect.gen(function* () {
      const {
        imageName,
        env,
        hostRepoDir,
        branch,
        copyToSandbox: copyPaths,
        agentName,
      } = yield* WorktreeSandboxConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const display = yield* Display;
      return {
        withSandbox: <A, E, R>(
          makeEffect: (info: SandboxInfo) => Effect.Effect<A, E, R | Sandbox>,
        ): Effect.Effect<
          A,
          E | DockerError | WorktreeError,
          Exclude<R, Sandbox>
        > => {
          const containerName = `sandcastle-${randomUUID()}`;

          return Effect.acquireUseRelease(
            // Acquire: prune stale worktrees (best-effort), create worktree, then start container
            WorktreeManager.pruneStale(hostRepoDir)
              .pipe(
                Effect.catchAll((e) =>
                  Effect.sync(() => {
                    console.error(
                      "[sandcastle] Warning: failed to prune stale worktrees:",
                      e.message,
                    );
                  }),
                ),
              )
              .pipe(
                Effect.andThen(
                  branch
                    ? WorktreeManager.create(hostRepoDir, { branch })
                    : WorktreeManager.create(hostRepoDir, { agentName }),
                ),
              )
              .pipe(Effect.provideService(FileSystem.FileSystem, fileSystem))
              .pipe(
                Effect.flatMap((worktreeInfo) =>
                  (copyPaths && copyPaths.length > 0
                    ? display.spinner(
                        "Copying to sandbox",
                        copyToSandbox(
                          copyPaths,
                          hostRepoDir,
                          worktreeInfo.path,
                        ),
                      )
                    : Effect.succeed(undefined)
                  ).pipe(Effect.map(() => worktreeInfo)),
                ),
              )
              .pipe(
                Effect.flatMap((worktreeInfo) => {
                  const gitDir = join(hostRepoDir, ".git");
                  const volumeMounts = [
                    `${worktreeInfo.path}:${SANDBOX_WORKSPACE_DIR}`,
                    `${gitDir}:${gitDir}`,
                  ];

                  const cleanup = () => {
                    forceRemoveContainerSync(containerName);
                    forceRemoveWorktreeSync(worktreeInfo.path, hostRepoDir);
                  };
                  const onSignal = () => {
                    cleanup();
                    process.exit(1);
                  };

                  const hostUid = process.getuid?.() ?? 1000;
                  const hostGid = process.getgid?.() ?? 1000;

                  return startContainer(
                    containerName,
                    imageName,
                    { ...env, HOME: "/home/agent" },
                    {
                      volumeMounts,
                      workdir: SANDBOX_WORKSPACE_DIR,
                      user: `${hostUid}:${hostGid}`,
                    },
                  ).pipe(
                    Effect.andThen(
                      chownInContainer(
                        containerName,
                        `${hostUid}:${hostGid}`,
                        "/home/agent",
                      ),
                    ),
                    Effect.tap(() =>
                      Effect.sync(() => {
                        process.on("exit", cleanup);
                        process.on("SIGINT", onSignal);
                        process.on("SIGTERM", onSignal);
                      }),
                    ),
                    Effect.map(() => ({ worktreeInfo, cleanup, onSignal })),
                  );
                }),
              ),
            // Use
            ({ worktreeInfo }) =>
              makeEffect({ hostWorktreePath: worktreeInfo.path }).pipe(
                Effect.provide(makeDockerSandboxLayer(containerName)),
              ) as Effect.Effect<A, E | DockerError, Exclude<R, Sandbox>>,
            // Release: remove container, then remove worktree
            ({ worktreeInfo, cleanup, onSignal }) =>
              Effect.sync(() => {
                process.removeListener("exit", cleanup);
                process.removeListener("SIGINT", onSignal);
                process.removeListener("SIGTERM", onSignal);
              }).pipe(
                Effect.andThen(removeContainer(containerName)),
                Effect.andThen(WorktreeManager.remove(worktreeInfo.path)),
                Effect.orDie,
              ),
          );
        },
      };
    }),
  ),
};
