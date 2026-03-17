import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { Sandbox } from "./Sandbox.js";

describe("FilesystemSandbox", () => {
  let sandboxDir: string;
  let hostDir: string;

  afterEach(async () => {
    // Temp dirs are cleaned up by OS
  });

  const setup = async () => {
    sandboxDir = await mkdtemp(join(tmpdir(), "sandbox-test-"));
    hostDir = await mkdtemp(join(tmpdir(), "host-test-"));
    return FilesystemSandbox.layer(sandboxDir);
  };

  it("exec runs a command and returns output", async () => {
    const layer = await setup();

    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.exec("echo hello")),
        Effect.provide(layer),
      ),
    );

    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("exec runs command in sandbox directory by default", async () => {
    const layer = await setup();

    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.exec("pwd")),
        Effect.provide(layer),
      ),
    );

    expect(result.stdout.trim()).toBe(sandboxDir);
  });

  it("exec respects cwd option", async () => {
    const layer = await setup();

    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.exec("pwd", { cwd: "/tmp" })),
        Effect.provide(layer),
      ),
    );

    expect(result.stdout.trim()).toBe("/tmp");
  });

  it("exec returns non-zero exit code on failure", async () => {
    const layer = await setup();

    const result = await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.exec("exit 42")),
        Effect.provide(layer),
      ),
    );

    expect(result.exitCode).toBe(42);
  });

  it("copyIn transfers a file from host to sandbox", async () => {
    const layer = await setup();

    const hostFile = join(hostDir, "test.txt");
    await writeFile(hostFile, "hello from host");

    const sandboxFile = join(sandboxDir, "test.txt");

    await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.copyIn(hostFile, sandboxFile)),
        Effect.provide(layer),
      ),
    );

    const content = await readFile(sandboxFile, "utf-8");
    expect(content).toBe("hello from host");
  });

  it("copyOut transfers a file from sandbox to host", async () => {
    const layer = await setup();

    const sandboxFile = join(sandboxDir, "result.txt");
    await writeFile(sandboxFile, "hello from sandbox");

    const hostFile = join(hostDir, "result.txt");

    await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.copyOut(sandboxFile, hostFile)),
        Effect.provide(layer),
      ),
    );

    const content = await readFile(hostFile, "utf-8");
    expect(content).toBe("hello from sandbox");
  });

  it("copyIn creates parent directories", async () => {
    const layer = await setup();

    const hostFile = join(hostDir, "test.txt");
    await writeFile(hostFile, "nested");

    const sandboxFile = join(sandboxDir, "deep", "nested", "test.txt");

    await Effect.runPromise(
      Sandbox.pipe(
        Effect.flatMap((s) => s.copyIn(hostFile, sandboxFile)),
        Effect.provide(layer),
      ),
    );

    const content = await readFile(sandboxFile, "utf-8");
    expect(content).toBe("nested");
  });
});
