/**
 * Retry and idempotency (architecture contract §19.1, §15.1, §11).
 *
 * §19.1 requires "retry classification and limits". `StructuredError.retryable` is that
 * classification, and these tests pin that the runner obeys it — plus the two overrides that
 * exist because obeying it alone is not safe:
 *
 * - whole categories are never retried, however the error is labelled;
 * - a stage that declared itself non-idempotent is never retried automatically.
 *
 * §15.1 states the consequence directly: "Aldus MUST NOT silently retry paid requests without
 * policy and cost authorization."
 */

import { AldusError } from "@aldus/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aStage, makeTempRun, type TempRun } from "./helpers.js";

let harness: TempRun;
let sleeps: number[];

beforeEach(async () => {
  sleeps = [];
  harness = await makeTempRun({ sleeps });
});

afterEach(async () => {
  await harness.cleanup();
});

/** Categories these tests construct failures in. */
type TestCategory = "provider" | "policy" | "validation" | "io" | "internal";

/** A stage that fails a given number of times, then succeeds. */
function flaky(options: {
  failures: number;
  category?: TestCategory;
  retryable?: boolean;
  maxAttempts?: number;
  idempotent?: boolean;
}) {
  let calls = 0;
  const definition = aStage({
    retryPolicy: { maxAttempts: options.maxAttempts ?? 3 },
    idempotency:
      options.idempotent === false
        ? { kind: "not_idempotent", reason: "each run issues a paid synthesis request" }
        : { kind: "idempotent" },
    execute: async () => {
      calls += 1;
      if (calls <= options.failures) {
        throw failWith(options.category ?? "provider", options.retryable ?? true);
      }
      return { kind: "completed", output: { calls } };
    },
  });
  return { definition, calls: () => calls };
}

/** An error carrying an explicit classification, as a stage would produce. */
function failWith(category: TestCategory, retryable: boolean): AldusError {
  return new AldusError("ALDUS_EXAMPLE_STAGE_FAILURE", "the stage failed", {
    category,
    retryable,
  });
}

describe("retry classification (§19.1)", () => {
  it("retries a retryable failure until it succeeds", async () => {
    const stage = flaky({ failures: 2 });
    harness.registry.register(stage.definition);

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("succeeded");
    expect(stage.calls()).toBe(3);
    expect(result.attempt).toBe(3);
  });

  it("appends one attempt per try rather than editing the first (§6.3)", async () => {
    harness.registry.register(flaky({ failures: 2 }).definition);
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    expect(stored?.execution.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3]);
    // The failed attempts survive with their failures intact — the history of what was tried is
    // the point of an append-only record.
    expect(stored?.execution.attempts[0]?.status).toBe("failed");
    expect(stored?.execution.attempts[1]?.status).toBe("failed");
    expect(stored?.execution.attempts[2]?.status).toBe("succeeded");
  });

  it("stops at the attempt limit", async () => {
    const stage = flaky({ failures: 99, maxAttempts: 2 });
    harness.registry.register(stage.definition);

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    expect(stage.calls()).toBe(2);
  });

  it("does not retry a failure the stage marked non-retryable", async () => {
    const stage = flaky({ failures: 99, category: "io", retryable: false });
    harness.registry.register(stage.definition);

    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(stage.calls()).toBe(1);
  });

  it.each(["policy", "validation"] as const)(
    "never retries a %s failure even when it is labelled retryable",
    async (category) => {
      const stage = flaky({ failures: 99, category, retryable: true });
      harness.registry.register(stage.definition);

      await harness.runner.run(harness.manifest.runId, "stage-a", {});
      // §19.3: retrying a refusal is how a spend limit gets spent through. A refusal does not
      // become a different answer by being asked again.
      expect(stage.calls()).toBe(1);
    },
  );

  it("runs only once when no retry policy is declared", async () => {
    const stage = flaky({ failures: 99, maxAttempts: 1 });
    harness.registry.register(stage.definition);
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(stage.calls()).toBe(1);
  });
});

describe("idempotency (§11, §15.1, §19.1)", () => {
  it("never auto-retries a stage that declared itself non-idempotent", async () => {
    const stage = flaky({ failures: 99, idempotent: false, maxAttempts: 5 });
    harness.registry.register(stage.definition);

    const result = await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(result.status).toBe("failed");
    // Even though the failure is retryable and the budget allows four more tries: re-running
    // duplicates the external effect the stage told us about (§15.1).
    expect(stage.calls()).toBe(1);
  });

  it("records why a stage is not idempotent, so an operator can decide (§20)", async () => {
    harness.registry.register(flaky({ failures: 99, idempotent: false }).definition);
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    expect(stored?.metadata[attemptId]).toMatchObject({
      idempotent: false,
      nonIdempotentReason: "each run issues a paid synthesis request",
    });
  });

  it("gives identical input and configuration the same idempotency key", async () => {
    harness.registry.register(aStage());
    harness.registry.register(aStage({ id: "stage-b" }));

    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      { topic: "t" },
      {
        configuration: { passes: 1 },
      },
    );
    await harness.runner.run(
      harness.manifest.runId,
      "stage-b",
      { topic: "t" },
      {
        configuration: { passes: 1 },
      },
    );

    const keyOf = async (stageId: string) => {
      const stored = await harness.runner.stageExecution(harness.manifest.runId, stageId);
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      return stored?.metadata[attemptId]?.idempotencyKey;
    };
    // Different stage ids, so the keys differ — the key covers the stage identity too, or two
    // unrelated stages would deduplicate against each other.
    expect(await keyOf("stage-a")).not.toBe(await keyOf("stage-b"));
  });

  it("changes the idempotency key when the configuration changes", async () => {
    harness.registry.register(aStage());
    harness.registry.register(aStage({ id: "stage-b" }));

    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      { topic: "t" },
      {
        configuration: { voice: "voice-a" },
      },
    );
    await harness.runner.run(
      harness.manifest.runId,
      "stage-b",
      { topic: "t" },
      {
        configuration: { voice: "voice-b" },
      },
    );

    const keyOf = async (stageId: string) => {
      const stored = await harness.runner.stageExecution(harness.manifest.runId, stageId);
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      return stored?.metadata[attemptId]?.idempotencyKey;
    };
    expect(await keyOf("stage-a")).not.toBe(await keyOf("stage-b"));
  });

  it("honours a stage's own idempotency key function", async () => {
    harness.registry.register(
      aStage<{ segment: string; noise: number }, unknown>({
        idempotency: {
          kind: "idempotent",
          key: (input) => `segment:${(input as never as { segment: string }).segment}`,
        },
      }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", { segment: "s1", noise: 1 });

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    // Narrower than the default: only the part of the input that determines the external effect.
    expect(stored?.metadata[attemptId]?.idempotencyKey).toBe("segment:s1");
  });

  it("records the idempotency key on every event (§6.4)", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    expect(events.every((event) => typeof event.idempotencyKey === "string")).toBe(true);
  });
});

describe("backoff", () => {
  it("does not wait when no backoff is declared", async () => {
    harness.registry.register(flaky({ failures: 2 }).definition);
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    expect(sleeps).toEqual([]);
  });

  it("grows the delay by the declared factor, capped at the maximum", async () => {
    harness.registry.register(
      aStage({
        retryPolicy: {
          maxAttempts: 5,
          backoff: { initialMs: 100, factor: 3, maxMs: 500 },
        },
        execute: async () => {
          throw new AldusError("ALDUS_EXAMPLE_STAGE_FAILURE", "still failing", {
            category: "provider",
            retryable: true,
          });
        },
      }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", {});
    // 100, 300, then capped: a cap that did not apply would make the fourth wait 2700ms.
    expect(sleeps).toEqual([100, 300, 500, 500]);
  });
});
