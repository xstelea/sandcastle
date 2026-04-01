import { Effect, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { type DisplayEntry, SilentDisplay } from "./Display.js";
import {
  substitutePromptArgs,
  validateNoBuiltInArgOverride,
  BUILT_IN_PROMPT_ARG_KEYS,
} from "./PromptArgumentSubstitution.js";
import { PromptError } from "./errors.js";

describe("PromptArgumentSubstitution", () => {
  const setup = () => {
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layer = SilentDisplay.layer(displayRef);
    return { layer, displayRef };
  };

  const run = (
    prompt: string,
    args: Record<string, string | number | boolean>,
    layer: Layer.Layer<import("./Display.js").Display>,
  ) =>
    Effect.runPromise(
      substitutePromptArgs(prompt, args).pipe(Effect.provide(layer)),
    );

  const runFail = (
    prompt: string,
    args: Record<string, string | number | boolean>,
    layer: Layer.Layer<import("./Display.js").Display>,
  ) =>
    Effect.runPromise(
      substitutePromptArgs(prompt, args).pipe(
        Effect.flip,
        Effect.provide(layer),
      ),
    );

  it("replaces a single {{KEY}} placeholder with its value", async () => {
    const { layer } = setup();
    const result = await run("Hello {{NAME}}", { NAME: "world" }, layer);
    expect(result).toBe("Hello world");
  });

  it("replaces multiple different placeholders", async () => {
    const { layer } = setup();
    const result = await run(
      "Issue #{{NUM}}: {{TITLE}}",
      { NUM: "42", TITLE: "Fix bug" },
      layer,
    );
    expect(result).toBe("Issue #42: Fix bug");
  });

  it("replaces the same key used more than once", async () => {
    const { layer } = setup();
    const result = await run(
      "{{KEY}} and {{KEY}} again",
      { KEY: "val" },
      layer,
    );
    expect(result).toBe("val and val again");
  });

  it("coerces number values to strings", async () => {
    const { layer } = setup();
    const result = await run("Issue #{{NUM}}", { NUM: 42 }, layer);
    expect(result).toBe("Issue #42");
  });

  it("coerces boolean values to strings", async () => {
    const { layer } = setup();
    const result = await run("Flag: {{ENABLED}}", { ENABLED: true }, layer);
    expect(result).toBe("Flag: true");
  });

  it("throws PromptError when a placeholder has no matching arg", async () => {
    const { layer } = setup();
    const error = await runFail("Hello {{MISSING}}", {}, layer);
    expect(error).toBeInstanceOf(PromptError);
    expect(error._tag).toBe("PromptError");
    expect(error.message).toContain("MISSING");
  });

  it("logs a warning for unused prompt args", async () => {
    const { layer, displayRef } = setup();
    await run("Hello world", { UNUSED: "value" }, layer);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toContain("UNUSED");
  });

  it("passes through a prompt with no placeholders and no args", async () => {
    const { layer } = setup();
    const prompt = "Just a plain prompt with no placeholders.";
    const result = await run(prompt, {}, layer);
    expect(result).toBe(prompt);
  });

  it("substitutes placeholders inside shell expressions", async () => {
    const { layer } = setup();
    const result = await run(
      "Output: !`gh issue view {{NUM}}`",
      { NUM: 123 },
      layer,
    );
    expect(result).toBe("Output: !`gh issue view 123`");
  });

  it("handles keys with underscores and digits", async () => {
    const { layer } = setup();
    const result = await run("{{MY_KEY_2}} here", { MY_KEY_2: "value" }, layer);
    expect(result).toBe("value here");
  });

  it("reports the first missing key when multiple are missing", async () => {
    const { layer } = setup();
    const error = await runFail("{{A}} and {{B}}", {}, layer);
    expect(error).toBeInstanceOf(PromptError);
    // Should mention at least one of the missing keys
    expect(error.message).toMatch(/A|B/);
  });

  it("warns about multiple unused args", async () => {
    const { layer, displayRef } = setup();
    await run("No placeholders", { FOO: "1", BAR: "2" }, layer);
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    expect(warnings).toHaveLength(2);
  });

  it("does not warn about unused args listed in silentKeys", async () => {
    const { layer, displayRef } = setup();
    await Effect.runPromise(
      substitutePromptArgs(
        "No built-in placeholders here",
        { SOURCE_BRANCH: "feat/x", TARGET_BRANCH: "main", USER_ARG: "val" },
        new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]),
      ).pipe(Effect.provide(layer)),
    );
    const entries = await Effect.runPromise(Ref.get(displayRef));
    const warnings = entries.filter(
      (e) => e._tag === "status" && e.severity === "warn",
    );
    // Only USER_ARG should warn — SOURCE_BRANCH and TARGET_BRANCH are silent
    expect(warnings).toHaveLength(1);
    expect((warnings[0] as { message: string }).message).toContain("USER_ARG");
  });

  it("still substitutes silent keys when they appear in the prompt", async () => {
    const { layer } = setup();
    const result = await Effect.runPromise(
      substitutePromptArgs(
        "Branch: {{SOURCE_BRANCH}}",
        { SOURCE_BRANCH: "feat/my-feature", TARGET_BRANCH: "main" },
        new Set(["SOURCE_BRANCH", "TARGET_BRANCH"]),
      ).pipe(Effect.provide(layer)),
    );
    expect(result).toBe("Branch: feat/my-feature");
  });
});

describe("validateNoBuiltInArgOverride", () => {
  it("succeeds when promptArgs contains no built-in keys", async () => {
    await expect(
      Effect.runPromise(validateNoBuiltInArgOverride({ ISSUE_NUMBER: "42" })),
    ).resolves.toBeUndefined();
  });

  it("succeeds for empty promptArgs", async () => {
    await expect(
      Effect.runPromise(validateNoBuiltInArgOverride({})),
    ).resolves.toBeUndefined();
  });

  it("fails with PromptError when SOURCE_BRANCH is provided", async () => {
    const error = await Effect.runPromise(
      validateNoBuiltInArgOverride({ SOURCE_BRANCH: "my-branch" }).pipe(
        Effect.flip,
      ),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("SOURCE_BRANCH");
    expect(error.message).toContain("built-in");
  });

  it("fails with PromptError when TARGET_BRANCH is provided", async () => {
    const error = await Effect.runPromise(
      validateNoBuiltInArgOverride({ TARGET_BRANCH: "main" }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(PromptError);
    expect(error.message).toContain("TARGET_BRANCH");
    expect(error.message).toContain("built-in");
  });
});

describe("BUILT_IN_PROMPT_ARG_KEYS", () => {
  it("includes SOURCE_BRANCH and TARGET_BRANCH", () => {
    expect(BUILT_IN_PROMPT_ARG_KEYS).toContain("SOURCE_BRANCH");
    expect(BUILT_IN_PROMPT_ARG_KEYS).toContain("TARGET_BRANCH");
  });
});
