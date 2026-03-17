import { Effect, Layer } from "effect";
import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Sandbox, SandboxError, type SandboxService } from "./Sandbox.js";

const makeFilesystemSandbox = (sandboxDir: string): SandboxService => ({
  exec: (command, options) =>
    Effect.async((resume) => {
      execFile(
        "sh",
        ["-c", command],
        { cwd: options?.cwd ?? sandboxDir },
        (error, stdout, stderr) => {
          if (error && error.code === undefined) {
            resume(
              Effect.fail(
                new SandboxError("exec", `Failed to exec: ${error.message}`),
              ),
            );
          } else {
            resume(
              Effect.succeed({
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                exitCode:
                  typeof error?.code === "number" ? error.code : (0 as number),
              }),
            );
          }
        },
      );
    }),

  copyIn: (hostPath, sandboxPath) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(sandboxPath), { recursive: true });
        await copyFile(hostPath, sandboxPath);
      },
      catch: (error) =>
        new SandboxError(
          "copyIn",
          `Failed to copy ${hostPath} -> ${sandboxPath}: ${error}`,
        ),
    }),

  copyOut: (sandboxPath, hostPath) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(hostPath), { recursive: true });
        await copyFile(sandboxPath, hostPath);
      },
      catch: (error) =>
        new SandboxError(
          "copyOut",
          `Failed to copy ${sandboxPath} -> ${hostPath}: ${error}`,
        ),
    }),
});

export const FilesystemSandbox = {
  layer: (sandboxDir: string): Layer.Layer<Sandbox> =>
    Layer.succeed(Sandbox, makeFilesystemSandbox(sandboxDir)),
};
