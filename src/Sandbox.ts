import { Context, Effect } from "effect";

export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class SandboxError {
  readonly _tag = "SandboxError";
  constructor(
    readonly operation: string,
    readonly message: string,
  ) {}
}

export interface SandboxService {
  readonly exec: (
    command: string,
    options?: { cwd?: string },
  ) => Effect.Effect<ExecResult, SandboxError>;

  readonly copyIn: (
    hostPath: string,
    sandboxPath: string,
  ) => Effect.Effect<void, SandboxError>;

  readonly copyOut: (
    sandboxPath: string,
    hostPath: string,
  ) => Effect.Effect<void, SandboxError>;
}

export class Sandbox extends Context.Tag("Sandbox")<
  Sandbox,
  SandboxService
>() {}
