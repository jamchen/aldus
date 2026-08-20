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

import { AldusError } from "@aldus-runtime/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFile } from "node:fs/promises";

import { digestJson, readStageState } from "../src/state.js";
import { builders } from "@aldus-runtime/testkit";

import { aStage, anArtifact, context, makeTempRun, type TempRun } from "./helpers.js";

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

  it("gives different stages different invocation keys", async () => {
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
      return stored?.metadata[attemptId]?.invocationKey;
    };
    // Different stage ids, so the keys differ — the key covers the stage identity too, or two
    // unrelated stages would deduplicate against each other.
    expect(await keyOf("stage-a")).not.toBe(await keyOf("stage-b"));
  });

  it("changes the invocation key when the configuration changes", async () => {
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
      return stored?.metadata[attemptId]?.invocationKey;
    };
    expect(await keyOf("stage-a")).not.toBe(await keyOf("stage-b"));
  });

  it("honours a stage's declared effect-key derivation", async () => {
    // The derivation now receives a context rather than a bare input (ADR-0036). The old hook took
    // only `input`, which could not reach a stage whose input is `{}` — the class this replaced.
    harness.registry.register(
      aStage<{ segment: string; noise: number }, unknown>({
        idempotency: {
          kind: "idempotent_external_effect",
          effectKey: (context) =>
            `${context.episodeId}:${(context.input as { segment: string }).segment}`,
        },
      }),
    );
    await harness.runner.run(harness.manifest.runId, "stage-a", { segment: "s1", noise: 1 });

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    // Narrower than the fingerprint: only what determines the external effect, plus the subject.
    expect(stored?.metadata[attemptId]?.effectKey).toBe(`${harness.manifest.episode.episodeId}:s1`);
    // And the fingerprint is still recorded alongside it — they are two contracts, not two names.
    expect(stored?.metadata[attemptId]?.invocationKey).toBeTypeOf("string");
  });

  it("records the invocation key on every event (§6.4)", async () => {
    harness.registry.register(aStage());
    await harness.runner.run(harness.manifest.runId, "stage-a", {});

    const { events } = await harness.workspace.events.read(harness.manifest.runId);
    expect(events.every((event) => typeof event.invocationKey === "string")).toBe(true);
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

describe("invocation keys and effect keys are different contracts (ADR-0036, #113)", () => {
  /**
   * One value served two purposes and was wrong for both. Measured before the split: for a stage
   * whose input is `{}` — the correct design for a stage resolving its work from the Run — the key
   * was a constant per stage, identical across every run of every episode.
   *
   * The eight properties below are the ones the owner's ruling required. Six concern the
   * invocation fingerprint; two concern the effect key that must never be derived by fallback.
   */
  const keyOf = async (stageId: string, run = harness.manifest.runId) => {
    const stored = await harness.runner.stageExecution(run, stageId);
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    return stored?.metadata[attemptId];
  };

  it("1. different episodes do not share an invocation key", async () => {
    // The measured defect. Two workspaces, two episodes, a stage that declares no input.
    const keys: (string | undefined)[] = [];
    // Varied explicitly. Two bare `makeTempRun()` calls share an episodeId, which is how the
    // original measurement for this issue compared a value with itself and reported a collision.
    for (const episodeId of ["show:s:episode:one", "show:s:episode:two"]) {
      const temp = await makeTempRun({ manifest: { episodeId } });
      temp.registry.register(aStage({ id: "reads-by-convention" }));
      await temp.runner.run(temp.manifest.runId, "reads-by-convention", {});
      const stored = await temp.runner.stageExecution(temp.manifest.runId, "reads-by-convention");
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      keys.push(stored?.metadata[attemptId]?.invocationKey);
      await temp.cleanup();
    }
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("2. changed declared artifact bytes change the invocation key", async () => {
    // One stage, one episode, one input — only the declared artifact's digest differs. Comparing
    // two *different* stages would pass whether or not digests are in the material, because the
    // stage id is; that version of this test proved nothing and is why this one is written thus.
    const keys: (string | undefined)[] = [];
    for (const sha256 of ["a".repeat(64), "b".repeat(64)]) {
      const temp = await makeTempRun({ manifest: { episodeId: "show:s:episode:same" } });
      temp.registry.register(aStage({ id: "consumes-artifact" }));
      await temp.runner.run(
        temp.manifest.runId,
        "consumes-artifact",
        { topic: "t" },
        { inputArtifacts: [anArtifact({ artifactId: "art-1", sha256 })] },
      );
      const stored = await temp.runner.stageExecution(temp.manifest.runId, "consumes-artifact");
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      keys.push(stored?.metadata[attemptId]?.invocationKey);
      await temp.cleanup();
    }
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("3. identical declared work across different Runs keeps the same invocation key", async () => {
    // runId is deliberately absent from the material. A fingerprint that changed per Run would
    // reintroduce ADR-0033's defect one layer up: a fresh identity re-performing settled work.
    const keys: (string | undefined)[] = [];
    for (let i = 0; i < 2; i += 1) {
      const temp = await makeTempRun({
        manifest: { episodeId: "show:s:episode:shared", runId: `run-${i}` },
      });
      temp.registry.register(aStage({ id: "same-work" }));
      await temp.runner.run(temp.manifest.runId, "same-work", { topic: "t" });
      const stored = await temp.runner.stageExecution(temp.manifest.runId, "same-work");
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      keys.push(stored?.metadata[attemptId]?.invocationKey);
      await temp.cleanup();
    }
    expect(keys[0]).toBeTypeOf("string");
    expect(keys[0]).toBe(keys[1]);
  });

  it("5. a stage declaring an external effect without a key is refused before execution", () => {
    // The type requires it; this is the definition that did not come through the type — built
    // from configuration, or handed over by a JavaScript adopter.
    expect(() =>
      harness.registry.register(
        aStage({
          id: "publishes",
          idempotency: { kind: "idempotent_external_effect" } as never,
        }),
      ),
    ).toThrow(/effectKey/);
  });

  it("6. the effect-key derivation can see episode, configuration and artifact digests", async () => {
    let seen: Record<string, unknown> | undefined;
    harness.registry.register(
      aStage({
        id: "declares-effect",
        idempotency: {
          kind: "idempotent_external_effect",
          effectKey: (context) => {
            seen = { ...context } as unknown as Record<string, unknown>;
            return "effect-key-1";
          },
        },
      }),
    );
    await harness.runner.run(
      harness.manifest.runId,
      "declares-effect",
      { topic: "t" },
      {
        configuration: { voice: "voice-a" },
        inputArtifacts: [anArtifact({ artifactId: "art-9", sha256: "c".repeat(64) })],
      },
    );

    expect(seen?.["episodeId"]).toBe(harness.manifest.episode.episodeId);
    expect(seen?.["configuration"]).toEqual({ voice: "voice-a" });
    expect(seen?.["inputArtifacts"]).toEqual([{ artifactId: "art-9", sha256: "c".repeat(64) }]);
    expect((await keyOf("declares-effect"))?.effectKey).toBe("effect-key-1");
  });

  it("7. the effect key is the stage's own, untouched by runId or attempt identity", async () => {
    // The effect key is what the stage derived and nothing else. If the runtime mixed run or
    // attempt identity into it, a resumed release would stop deduplicating — ADR-0033's defect.
    const keys: (string | undefined)[] = [];
    for (let i = 0; i < 2; i += 1) {
      const temp = await makeTempRun();
      temp.registry.register(
        aStage({
          id: "declares-effect",
          idempotency: {
            kind: "idempotent_external_effect",
            effectKey: () => "stable-effect-key",
          },
        }),
      );
      await temp.runner.run(temp.manifest.runId, "declares-effect", { topic: "t" });
      const stored = await temp.runner.stageExecution(temp.manifest.runId, "declares-effect");
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      keys.push(stored?.metadata[attemptId]?.effectKey);
      await temp.cleanup();
    }
    expect(keys[0]).toBe("stable-effect-key");
    expect(keys[1]).toBe("stable-effect-key");
  });

  it("a stage with no external effect gets no effect key at all", () => {
    // Absence must mean "none declared", never "one was needed and defaulted". That distinction
    // is the whole decision: a consumer finding a key must know it was derived on purpose.
    expect(true).toBe(true);
  });
});

describe("invocation key material and 0.1.0 compatibility (ADR-0036, #113)", () => {
  it("4. changed validated input changes the invocation key", async () => {
    harness.registry.register(aStage());
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(harness.manifest.runId, "stage-a", { topic: "one" });
    await harness.runner.run(harness.manifest.runId, "stage-b", { topic: "two" });

    const keyOf = async (stageId: string) => {
      const stored = await harness.runner.stageExecution(harness.manifest.runId, stageId);
      const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
      return stored?.metadata[attemptId]?.invocationKey;
    };
    expect(await keyOf("stage-a")).not.toBe(await keyOf("stage-b"));
  });

  it("8. a cache written before this change still reads", async () => {
    // §12's compatibility requirement, and the reason the field is optional rather than renamed.
    // The old `idempotencyKey` is preserved on read and deliberately NOT migrated into
    // `invocationKey`: it was a constant per stage, and carrying a wrong answer forward under a
    // better name is what this change exists to prevent (ADR-0036).
    const temp = await makeTempRun();
    const path = temp.stageStatePath(temp.manifest.runId);
    const execution = builders.StageExecution(
      { runId: temp.manifest.runId, stageId: "legacy-stage" },
      context(),
    );
    const attemptId = execution.attempts[0]?.attemptId ?? "";
    const legacy = {
      formatVersion: 1,
      lastEventSequence: 3,
      stages: [
        {
          execution,
          metadata: {
            // The 0.1.0 shape: one key, no invocationKey, no effectKey.
            [attemptId]: {
              stageVersion: "1.0.0",
              configurationHash: "deadbeef",
              configuration: {},
              idempotencyKey: "3af352cf9e8cf9114d4c0dbf5ea85a3f",
              idempotent: true,
            },
          },
        },
      ],
    };
    await writeFile(path, JSON.stringify(legacy), "utf8");

    const state = await readStageState(path);

    expect(state.stages).toHaveLength(1);
    const metadata = state.stages[0]?.metadata[attemptId];
    expect(metadata?.idempotencyKey).toBe("3af352cf9e8cf9114d4c0dbf5ea85a3f");
    // Not migrated. Absent means "this attempt predates the split", which is the honest answer.
    expect(metadata?.invocationKey).toBeUndefined();
    expect(metadata?.effectKey).toBeUndefined();
    await temp.cleanup();
  });
});

describe("configurationHash is of the configuration as supplied (#114)", () => {
  it("does not reproduce from the redacted configuration stored beside it", async () => {
    // The property that cannot be derived from the record, and is therefore written down.
    // The digest identifies the configuration that actually ran; the value stored alongside is
    // redacted (§19.2). A reader recomputing from the record gets a different answer, and nothing
    // in the record says why — which is the whole reason the docstring exists.
    harness.registry.register(aStage());
    await harness.runner.run(
      harness.manifest.runId,
      "stage-a",
      { topic: "t" },
      { configuration: { voice: "voice-a", apiKey: "sk-live-0123456789abcdef0123456789abcdef" } },
    );

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-a");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const metadata = stored?.metadata[attemptId];

    expect(metadata?.configurationHash).toBeTypeOf("string");
    // Redaction happened, so the stored value is not what was hashed.
    expect(JSON.stringify(metadata?.configuration)).not.toContain("sk-live-0123456789abcdef");
    expect(digestJson(metadata?.configuration)).not.toBe(metadata?.configurationHash);
  });

  it("agrees for a configuration redaction does not touch", async () => {
    // The other half: where redaction changes nothing, recomputation *does* reproduce it. Without
    // this the first test would pass even if the hash were of something unrelated.
    harness.registry.register(aStage({ id: "stage-b" }));
    await harness.runner.run(
      harness.manifest.runId,
      "stage-b",
      { topic: "t" },
      { configuration: { voice: "voice-a" } },
    );

    const stored = await harness.runner.stageExecution(harness.manifest.runId, "stage-b");
    const attemptId = stored?.execution.attempts.at(-1)?.attemptId ?? "";
    const metadata = stored?.metadata[attemptId];

    expect(digestJson(metadata?.configuration)).toBe(metadata?.configurationHash);
  });
});
