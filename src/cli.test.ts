import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

const getHead = async (dir: string) => {
  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: dir });
  return stdout.trim();
};

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");

const runCli = (args: string, cwd: string) =>
  execAsync(`node ${cliPath} ${args}`, { cwd });

describe("sandcastle CLI", () => {
  it("sync-in command syncs host repo into sandbox", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "cli-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello world", "initial commit");

    await runCli(`sync-in --sandbox-dir "${sandboxDir}"`, hostDir);

    // Verify sync happened
    const hostHead = await getHead(hostDir);
    const sandboxHead = await getHead(sandboxRepoDir);
    expect(sandboxHead).toBe(hostHead);

    const content = await readFile(join(sandboxRepoDir, "hello.txt"), "utf-8");
    expect(content).toBe("hello world");
  });

  it("sync-out command syncs sandbox changes back to host", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "cli-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Sync in first
    await runCli(`sync-in --sandbox-dir "${sandboxDir}"`, hostDir);
    const baseHead = await getHead(sandboxRepoDir);

    // Configure git in sandbox (cloned repo doesn't inherit host config)
    await execAsync('git config user.email "test@test.com"', {
      cwd: sandboxRepoDir,
    });
    await execAsync('git config user.name "Test"', { cwd: sandboxRepoDir });

    // Make a commit in the sandbox
    await commitFile(
      sandboxRepoDir,
      "new-file.txt",
      "from sandbox",
      "sandbox commit",
    );

    // Sync out
    await runCli(
      `sync-out --sandbox-dir "${sandboxDir}" --base-head "${baseHead}"`,
      hostDir,
    );

    // Verify the commit arrived on host
    const content = await readFile(join(hostDir, "new-file.txt"), "utf-8");
    expect(content).toBe("from sandbox");
  });

  it("sync-in respects .sandcastle/config.json postSyncIn config", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    const sandboxDir = await mkdtemp(join(tmpdir(), "cli-sandbox-"));
    const sandboxRepoDir = join(sandboxDir, "repo");

    await initRepo(hostDir);
    await mkdir(join(hostDir, ".sandcastle"));
    await writeFile(
      join(hostDir, ".sandcastle", "config.json"),
      JSON.stringify({ postSyncIn: "touch post-sync-marker" }),
    );
    await execAsync("git add -A && git commit -m 'add config'", {
      cwd: hostDir,
    });

    await runCli(`sync-in --sandbox-dir "${sandboxDir}"`, hostDir);

    // Verify postSyncIn ran
    const { stdout } = await execAsync("ls post-sync-marker", {
      cwd: sandboxRepoDir,
    });
    expect(stdout.trim()).toBe("post-sync-marker");
  });

  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("sandcastle");
    expect(stdout).toContain("sync-in");
    expect(stdout).toContain("sync-out");
    expect(stdout).toContain("setup");
    expect(stdout).toContain("cleanup");
    expect(stdout).toContain("run");
    expect(stdout).toContain("interactive");
  });
});
