import { Command, Options } from "@effect/cli";
import { Console, Effect } from "effect";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "./Config.js";
import { DockerSandbox } from "./DockerSandbox.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import {
  buildImage,
  cleanupContainer,
  startContainer,
} from "./DockerLifecycle.js";
import { orchestrate } from "./Orchestrator.js";
import { SandboxError } from "./Sandbox.js";
import { syncIn, syncOut } from "./SyncService.js";

// --- Shared options ---

const sandboxDirOption = Options.directory("sandbox-dir").pipe(
  Options.withDescription("Path to the sandbox directory"),
);

const containerOption = Options.text("container").pipe(
  Options.withDescription("Docker container name"),
  Options.withDefault("claude-sandbox"),
);

const containerOptional = Options.text("container").pipe(
  Options.withDescription("Docker container name (use Docker layer)"),
  Options.optional,
);

const baseHeadOption = Options.text("base-head").pipe(
  Options.withDescription(
    "The HEAD commit SHA from sync-in (used to determine new commits)",
  ),
);

// --- Setup command ---

const oauthTokenOption = Options.text("oauth-token").pipe(
  Options.withDescription("Claude Code OAuth token"),
);

const ghTokenOption = Options.text("gh-token").pipe(
  Options.withDescription("GitHub personal access token"),
);

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.withDefault("sandcastle:local"),
);

const setupCommand = Command.make(
  "setup",
  {
    container: containerOption,
    oauthToken: oauthTokenOption,
    ghToken: ghTokenOption,
    imageName: imageNameOption,
  },
  ({ container, oauthToken, ghToken, imageName }) =>
    Effect.gen(function* () {
      yield* Console.log(`Building Docker image '${imageName}'...`);
      yield* buildImage(imageName);

      yield* Console.log(`Starting container '${container}'...`);
      yield* startContainer(container, imageName, oauthToken, ghToken);

      yield* Console.log(
        `Setup complete! Container '${container}' is running.`,
      );
    }),
);

// --- Cleanup command ---

const cleanupCommand = Command.make(
  "cleanup",
  {
    container: containerOption,
    imageName: imageNameOption,
  },
  ({ container, imageName }) =>
    Effect.gen(function* () {
      yield* Console.log(`Cleaning up container '${container}'...`);
      yield* cleanupContainer(container, imageName);
      yield* Console.log("Cleanup complete.");
    }),
);

// --- Sync-in command ---

const SANDBOX_REPOS_DIR = "/home/agent/repos";

const syncInCommand = Command.make(
  "sync-in",
  { sandboxDir: sandboxDirOption, container: containerOptional },
  ({ sandboxDir, container }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;

      const useDocker = container._tag === "Some";
      const sandboxRepoDir = useDocker
        ? `${SANDBOX_REPOS_DIR}/${repoName}`
        : `${sandboxDir}/repo`;

      yield* Console.log(`Syncing ${hostRepoDir} into ${sandboxRepoDir}...`);

      const config = yield* readConfig(hostRepoDir);
      const layer = useDocker
        ? DockerSandbox.layer(container.value)
        : FilesystemSandbox.layer(sandboxDir);

      const { branch } = yield* syncIn(
        hostRepoDir,
        sandboxRepoDir,
        config,
      ).pipe(Effect.provide(layer));

      yield* Console.log(`Sync-in complete. Branch: ${branch}`);
    }),
);

// --- Sync-out command ---

const syncOutCommand = Command.make(
  "sync-out",
  {
    sandboxDir: sandboxDirOption,
    baseHead: baseHeadOption,
    container: containerOptional,
  },
  ({ sandboxDir, baseHead, container }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;

      const useDocker = container._tag === "Some";
      const sandboxRepoDir = useDocker
        ? `${SANDBOX_REPOS_DIR}/${repoName}`
        : `${sandboxDir}/repo`;

      yield* Console.log(
        `Syncing changes from ${sandboxRepoDir} back to ${hostRepoDir}...`,
      );

      const layer = useDocker
        ? DockerSandbox.layer(container.value)
        : FilesystemSandbox.layer(sandboxDir);

      yield* syncOut(hostRepoDir, sandboxRepoDir, baseHead).pipe(
        Effect.provide(layer),
      );

      yield* Console.log("Sync-out complete.");
    }),
);

// --- Run command ---

const iterationsOption = Options.integer("iterations").pipe(
  Options.withDescription("Number of agent iterations to run"),
  Options.withDefault(5),
);

const promptFileOption = Options.file("prompt-file").pipe(
  Options.withDescription("Path to the prompt file for the agent"),
  Options.optional,
);

const detectRepoFullName = (cwd: string): Effect.Effect<string, SandboxError> =>
  Effect.async((resume) => {
    execFile(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
      { cwd },
      (error, stdout) => {
        if (error) {
          resume(
            Effect.fail(
              new SandboxError(
                "detectRepo",
                `Failed to detect repo name: ${error.message}`,
              ),
            ),
          );
        } else {
          resume(Effect.succeed(stdout.toString().trim()));
        }
      },
    );
  });

const DEFAULT_PROMPT_PATH = join(
  import.meta.dirname,
  "..",
  "docker-container-experiment",
  "prompt.md",
);

const runCommand = Command.make(
  "run",
  {
    container: containerOption,
    iterations: iterationsOption,
    imageName: imageNameOption,
    promptFile: promptFileOption,
  },
  ({ container, iterations, promptFile }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      // Detect repo full name for issue fetching
      const repoFullName = yield* detectRepoFullName(hostRepoDir);

      // Load prompt
      const promptPath =
        promptFile._tag === "Some" ? promptFile.value : DEFAULT_PROMPT_PATH;
      const prompt = yield* Effect.tryPromise({
        try: () => readFile(promptPath, "utf-8"),
        catch: (e) =>
          new SandboxError("readPrompt", `Failed to read prompt: ${e}`),
      });

      // Read config
      const config = yield* readConfig(hostRepoDir);

      yield* Console.log(`=== SANDCASTLE RUN ===`);
      yield* Console.log(`Repo:       ${repoFullName}`);
      yield* Console.log(`Container:  ${container}`);
      yield* Console.log(`Iterations: ${iterations}`);
      yield* Console.log(``);

      const layer = DockerSandbox.layer(container);

      const result = yield* orchestrate({
        hostRepoDir,
        sandboxRepoDir,
        iterations,
        config,
        repoFullName,
        prompt,
      }).pipe(Effect.provide(layer));

      if (result.complete) {
        yield* Console.log(
          `\nRun complete: agent finished after ${result.iterationsRun} iteration(s).`,
        );
      } else {
        yield* Console.log(
          `\nRun complete: reached ${result.iterationsRun} iteration(s) without completion signal.`,
        );
      }
    }),
);

// --- Interactive command ---

const interactiveCommand = Command.make(
  "interactive",
  {
    container: containerOption,
  },
  ({ container }) =>
    Effect.gen(function* () {
      const hostRepoDir = process.cwd();
      const repoName = hostRepoDir.split("/").pop()!;
      const sandboxRepoDir = `${SANDBOX_REPOS_DIR}/${repoName}`;

      const config = yield* readConfig(hostRepoDir);
      const layer = DockerSandbox.layer(container);

      yield* Console.log("=== SANDCASTLE (Interactive) ===");
      yield* Console.log(`Container: ${container}`);
      yield* Console.log("");

      // Sync in
      yield* Console.log("Syncing repo into sandbox...");
      const { branch: _branch } = yield* syncIn(
        hostRepoDir,
        sandboxRepoDir,
        config,
      ).pipe(Effect.provide(layer));

      // Record base HEAD for sync-out
      const baseHead = yield* Effect.async<string, SandboxError>((resume) => {
        execFile(
          "docker",
          ["exec", "-w", sandboxRepoDir, container, "git", "rev-parse", "HEAD"],
          (error, stdout) => {
            if (error) {
              resume(
                Effect.fail(
                  new SandboxError(
                    "interactive",
                    `Failed to get sandbox HEAD: ${error.message}`,
                  ),
                ),
              );
            } else {
              resume(Effect.succeed(stdout.toString().trim()));
            }
          },
        );
      });

      // Launch interactive Claude session with TTY passthrough
      yield* Console.log("Launching interactive Claude session...");
      yield* Console.log("");

      const exitCode = yield* Effect.async<number, SandboxError>((resume) => {
        const proc = spawn(
          "docker",
          [
            "exec",
            "-it",
            "-w",
            sandboxRepoDir,
            container,
            "claude",
            "--dangerously-skip-permissions",
            "--model",
            "claude-opus-4-6",
          ],
          { stdio: "inherit" },
        );

        proc.on("error", (error) => {
          resume(
            Effect.fail(
              new SandboxError(
                "interactive",
                `Failed to launch Claude: ${error.message}`,
              ),
            ),
          );
        });

        proc.on("close", (code) => {
          resume(Effect.succeed(code ?? 0));
        });
      });

      yield* Console.log("");
      yield* Console.log(
        `Session ended (exit code ${exitCode}). Syncing changes back...`,
      );

      // Sync out
      yield* syncOut(hostRepoDir, sandboxRepoDir, baseHead).pipe(
        Effect.provide(layer),
      );

      yield* Console.log("Sync complete.");
    }),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Sandcastle v0.0.1");
    yield* Console.log("Use --help to see available commands.");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([
    syncInCommand,
    syncOutCommand,
    setupCommand,
    cleanupCommand,
    runCommand,
    interactiveCommand,
  ]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: "0.0.1",
});
