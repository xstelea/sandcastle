import { Effect } from "effect";
import { Display } from "./Display.js";
import { PromptError } from "./errors.js";

/**
 * A map of named values used for prompt argument substitution.
 * Each key corresponds to a `{{KEY}}` placeholder in the prompt; the value
 * replaces it before the prompt is passed to the agent.
 */
export type PromptArgs = Record<string, string | number | boolean>;

/**
 * Prompt argument keys that Sandcastle injects automatically.
 * These cannot be overridden via `promptArgs`.
 */
export const BUILT_IN_PROMPT_ARG_KEYS = [
  "SOURCE_BRANCH",
  "TARGET_BRANCH",
] as const;

const PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

/**
 * Validates that the user has not provided any built-in prompt argument keys.
 * Fails with a PromptError if any built-in key is found in `args`.
 */
export const validateNoBuiltInArgOverride = (
  args: PromptArgs,
): Effect.Effect<void, PromptError> => {
  for (const key of BUILT_IN_PROMPT_ARG_KEYS) {
    if (key in args) {
      return Effect.fail(
        new PromptError({
          message: `"${key}" is a built-in prompt argument and cannot be overridden via promptArgs`,
        }),
      );
    }
  }
  return Effect.void;
};

export const substitutePromptArgs = (
  prompt: string,
  args: PromptArgs,
  silentKeys?: ReadonlySet<string>,
): Effect.Effect<string, PromptError, Display> => {
  const matches = [...prompt.matchAll(PLACEHOLDER_PATTERN)];

  if (matches.length === 0 && Object.keys(args).length === 0) {
    return Effect.succeed(prompt);
  }

  return Effect.gen(function* () {
    const display = yield* Display;

    // Collect all keys referenced in the prompt
    const referencedKeys = new Set(matches.map((m) => m[1]!));

    // Check for missing keys (placeholder in prompt but no matching arg)
    for (const key of referencedKeys) {
      if (!(key in args)) {
        return yield* Effect.fail(
          new PromptError({
            message: `Prompt argument "{{${key}}}" has no matching value in promptArgs`,
          }),
        );
      }
    }

    // Warn about unused keys (arg provided but no matching placeholder)
    // Skip keys listed in silentKeys (e.g. built-in args)
    for (const key of Object.keys(args)) {
      if (!referencedKeys.has(key) && !silentKeys?.has(key)) {
        yield* display.status(
          `Prompt argument "${key}" was provided but not referenced in the prompt`,
          "warn",
        );
      }
    }

    // Replace all placeholders with their values
    const result = prompt.replace(PLACEHOLDER_PATTERN, (_match, key) =>
      args[key as string]!.toString(),
    );

    return result;
  });
};
