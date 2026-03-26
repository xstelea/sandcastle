import { Duration, Effect } from "effect";
import { Display } from "./Display.js";
import { preprocessPrompt } from "./PromptPreprocessor.js";
import { AgentError, TimeoutError } from "./errors.js";
import type { SandboxError } from "./errors.js";
import type { SandboxService } from "./SandboxFactory.js";
import { SandboxFactory } from "./SandboxFactory.js";
import { withSandboxLifecycle, type SandboxHooks } from "./SandboxLifecycle.js";

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly total_cost_usd: number;
  readonly num_turns: number;
  readonly duration_ms: number;
}

export const DEFAULT_MODEL = "claude-opus-4-6";

const extractUsage = (obj: Record<string, unknown>): TokenUsage | null => {
  const usage = obj.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.input_tokens !== "number" ||
    typeof usage.output_tokens !== "number"
  ) {
    return null;
  }
  return {
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_input_tokens:
      typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0,
    cache_creation_input_tokens:
      typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0,
    total_cost_usd:
      typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
    num_turns: typeof obj.num_turns === "number" ? obj.num_turns : 0,
    duration_ms: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
  };
};

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string; usage: TokenUsage | null }
  | { type: "tool_call"; name: string; args: string };

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/** Extract displayable events from a stream-json line */
export const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      return [{ type: "result", result: obj.result, usage: extractUsage(obj) }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

const TOOL_ARG_EXTRACTORS: Record<
  string,
  (input: Record<string, unknown>) => string | undefined
> = {
  Bash: (input) =>
    typeof input.command === "string" ? input.command : undefined,
  WebSearch: (input) =>
    typeof input.query === "string" ? input.query : undefined,
  WebFetch: (input) => (typeof input.url === "string" ? input.url : undefined),
  Agent: (input) =>
    typeof input.description === "string" ? input.description : undefined,
};

/**
 * Format a tool call for display. Returns null if the tool is not in the
 * allowlist or the required arg field is missing.
 */
export const formatToolCall = (
  name: string,
  input: Record<string, unknown>,
): { name: string; formattedArgs: string } | null => {
  const extractor = TOOL_ARG_EXTRACTORS[name];
  if (!extractor) return null;
  const arg = extractor(input);
  if (arg === undefined) return null;
  return { name, formattedArgs: arg };
};

const invokeAgent = (
  sandbox: SandboxService,
  sandboxRepoDir: string,
  prompt: string,
  model: string,
  onText: (text: string) => void,
  onToolCall: (name: string, formattedArgs: string) => void,
): Effect.Effect<{ result: string; usage: TokenUsage | null }, SandboxError> =>
  Effect.gen(function* () {
    let resultText = "";
    let tokenUsage: TokenUsage | null = null;

    const execResult = yield* sandbox.execStreaming(
      `claude --print --verbose --dangerously-skip-permissions --output-format stream-json --model ${model} -p ${shellEscape(prompt)}`,
      (line) => {
        for (const parsed of parseStreamJsonLine(line)) {
          if (parsed.type === "text") {
            onText(parsed.text);
          } else if (parsed.type === "result") {
            resultText = parsed.result;
            tokenUsage = parsed.usage;
          } else if (parsed.type === "tool_call") {
            onToolCall(parsed.name, parsed.args);
          }
        }
      },
      { cwd: sandboxRepoDir },
    );

    if (execResult.exitCode !== 0) {
      return yield* Effect.fail(
        new AgentError({
          message: `Claude exited with code ${execResult.exitCode}:\n${execResult.stderr}`,
        }),
      );
    }

    return { result: resultText || execResult.stdout, usage: tokenUsage };
  });

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

const formatNumber = (n: number): string => n.toLocaleString("en-US");

const formatUsageRows = (usage: TokenUsage): Record<string, string> => ({
  Tokens: `${formatNumber(usage.input_tokens)} in / ${formatNumber(usage.output_tokens)} out`,
  Turns: `${usage.num_turns}`,
});

const DEFAULT_COMPLETION_SIGNAL = "<promise>COMPLETE</promise>";
const DEFAULT_TIMEOUT_SECONDS = 20 * 60; // 1200 seconds

export interface OrchestrateOptions {
  readonly hostRepoDir: string;
  readonly sandboxRepoDir: string;
  readonly iterations: number;
  readonly hooks?: SandboxHooks;
  readonly prompt: string;
  readonly branch?: string;
  readonly model?: string;
  readonly completionSignal?: string;
  /** Timeout in seconds. If the run exceeds this, it fails with TimeoutError. Default: 1200 (20 minutes) */
  readonly timeoutSeconds?: number;
  /** Optional name for the run, prepended to status messages as [name] */
  readonly name?: string;
}

export interface OrchestrateResult {
  readonly iterationsRun: number;
  readonly wasCompletionSignalDetected: boolean;
  readonly stdout: string;
  readonly commits: { sha: string }[];
  readonly branch: string;
}

export const orchestrate = (
  options: OrchestrateOptions,
): Effect.Effect<OrchestrateResult, SandboxError, SandboxFactory | Display> => {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return Effect.gen(function* () {
    const factory = yield* SandboxFactory;
    const display = yield* Display;
    const { hostRepoDir, sandboxRepoDir, iterations, hooks, prompt, branch } =
      options;
    const resolvedModel = options.model ?? DEFAULT_MODEL;
    const completionSignal =
      options.completionSignal ?? DEFAULT_COMPLETION_SIGNAL;

    const label = (msg: string): string =>
      options.name ? `[${options.name}] ${msg}` : msg;

    const allCommits: { sha: string }[] = [];
    let allStdout = "";
    let resolvedBranch = "";

    for (let i = 1; i <= iterations; i++) {
      yield* display.status(label(`Iteration ${i}/${iterations}`), "info");

      const lifecycleResult = yield* factory.withSandbox(
        ({ hostWorktreePath }) =>
          withSandboxLifecycle(
            {
              hostRepoDir,
              sandboxRepoDir,
              hooks,
              branch,
              hostWorktreePath,
            },
            (ctx) =>
              Effect.gen(function* () {
                // Preprocess prompt (run !`command` expressions inside sandbox)
                const fullPrompt = yield* preprocessPrompt(
                  prompt,
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                );

                yield* display.status(label("Agent started"), "success");

                // Invoke the agent
                const onText = (text: string) => {
                  Effect.runPromise(display.text(text));
                };
                const onToolCall = (name: string, formattedArgs: string) => {
                  Effect.runPromise(display.toolCall(name, formattedArgs));
                };
                const { result: agentOutput, usage } = yield* invokeAgent(
                  ctx.sandbox,
                  ctx.sandboxRepoDir,
                  fullPrompt,
                  resolvedModel,
                  onText,
                  onToolCall,
                );

                yield* display.status(label("Agent stopped"), "info");

                // Log usage summary
                if (usage) {
                  yield* display.summary("Token Usage", formatUsageRows(usage));
                }

                // Check completion signal
                if (agentOutput.includes(completionSignal)) {
                  return {
                    wasCompletionSignalDetected: true,
                    stdout: agentOutput,
                  } as const;
                }
                return {
                  wasCompletionSignalDetected: false,
                  stdout: agentOutput,
                } as const;
              }),
          ),
      );

      allCommits.push(...lifecycleResult.commits);
      allStdout += lifecycleResult.result.stdout;
      resolvedBranch = lifecycleResult.branch;

      if (lifecycleResult.result.wasCompletionSignalDetected) {
        yield* display.status(
          label(`Agent signaled completion after ${i} iteration(s).`),
          "success",
        );
        return {
          iterationsRun: i,
          wasCompletionSignalDetected: true,
          stdout: allStdout,
          commits: allCommits,
          branch: resolvedBranch,
        };
      }
    }

    yield* display.status(
      label(`Reached max iterations (${iterations}).`),
      "info",
    );
    return {
      iterationsRun: iterations,
      wasCompletionSignalDetected: false,
      stdout: allStdout,
      commits: allCommits,
      branch: resolvedBranch,
    };
  }).pipe(
    Effect.timeoutFail({
      duration: Duration.seconds(timeoutSeconds),
      onTimeout: () =>
        new TimeoutError({
          message: `Run timed out after ${timeoutSeconds / 60} minutes`,
          timeoutSeconds,
        }),
    }),
  );
};
