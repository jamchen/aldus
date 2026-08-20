/**
 * The eight acceptance cases of the #138 ruling (contract §8.1, §11, §6.3; ADR-0040).
 *
 * One `it` per case, in the ruling's order, so the list is auditable against the ruling rather
 * than merely inspired by it.
 *
 * The case worth reading first is the conditional mode. A declaration that cannot express "this
 * mode owes a video, that one does not" would be either wrong or ignored for the adopter whose
 * render modes produce different sets — and an ignored declaration is worse than none, because it
 * reads as a check.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { aStage, anArtifact, makeTempRun, type TempRun } from "./helpers.js";

let temp: TempRun;

beforeEach(async () => {
  temp = await makeTempRun();
});

afterEach(async () => {
  await temp.cleanup();
});

/** A stage that records the artifacts it is given, so a test can vary what was produced. */
function producing(kinds: readonly string[], overrides: Record<string, unknown> = {}) {
  return aStage({
    id: "stage-a",
    execute: async (context) => {
      for (const kind of kinds) context.recordOutput(anArtifact({ kind }));
      return { kind: "completed", output: undefined };
    },
    ...overrides,
  });
}

describe("the eight acceptance cases of the #138 ruling", () => {
  it("1. an explicitly artifact-free Stage succeeds and records no expectation", async () => {
    temp.registry.register(aStage({ id: "stage-a", artifacts: { produces: "none" } }));

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect(result.status).toBe("succeeded");
    const stored = await temp.runner.stageExecution(temp.manifest.runId, "stage-a");
    // `undefined`, not `[]`. "This stage never registers anything" and "this invocation owed
    // nothing" are different statements and the trace keeps them apart.
    expect(stored?.execution.attempts.at(-1)?.expectedArtifacts).toBeUndefined();
  });

  it("2. a required artifact omitted fails the stage, non-retryably", async () => {
    temp.registry.register(
      producing([], {
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "RenderManifest", minCount: 1 }],
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_ARTIFACT_CONTRACT_UNMET");
    // Non-retryable: the stage would run again against the same contract and fail the same way,
    // having spent whatever it spends.
    expect(result.error?.retryable).toBe(false);
  });

  it("3. a conditional mode selects different required kinds", async () => {
    // Resolved from the validated input, which is the only place a mode may come from. A mode that
    // cannot be derived from input, configuration or declared input artifacts is a hidden input.
    const definition = producing(["RenderManifest"], {
      artifacts: {
        produces: "declared",
        resolve: (context: { input: unknown }) =>
          (context.input as { mode?: string })?.mode === "full"
            ? [{ kind: "RenderManifest", minCount: 1 }]
            : [],
      },
    });
    temp.registry.register(definition);

    // `full` owes a render, and one was produced.
    const full = await temp.runner.run(temp.manifest.runId, "stage-a", { mode: "full" });
    expect(full.status).toBe("succeeded");

    // The other mode owes nothing — and the same artifact is now undeclared, which is the point:
    // a mode that owes nothing is not a mode that may register anything.
    const draft = await temp.runner.run(temp.manifest.runId, "stage-a", { mode: "draft" });
    expect(draft.status).toBe("failed");
    expect(draft.error?.code).toBe("ALDUS_STAGE_ARTIFACT_CONTRACT_UNMET");
  });

  it("4. a registered kind the contract does not declare fails the stage", async () => {
    // The half an author would not think to ask for. A stage registering something its declaration
    // does not describe makes the declaration advisory.
    temp.registry.register(
      producing(["RenderManifest", "DebugDump"], {
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "RenderManifest", minCount: 1 }],
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect(result.status).toBe("failed");
    expect(result.error?.message).toContain("DebugDump");
    expect(result.error?.message).toContain("undeclared");
  });

  it("5. duplicate artifacts beyond maxCount fail the stage", async () => {
    temp.registry.register(
      producing(["RenderManifest", "RenderManifest"], {
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "RenderManifest", minCount: 1, maxCount: 1 }],
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("ALDUS_STAGE_ARTIFACT_CONTRACT_UNMET");
  });

  it("6. multiple required artifacts of one kind are satisfied by producing them", async () => {
    // Cardinality is not a boolean. A stage owing one segment per chapter owes a number, and a
    // contract that could only say "at least one" would pass a stage that produced one of twelve.
    temp.registry.register(
      producing(["SegmentAudio", "SegmentAudio", "SegmentAudio"], {
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "SegmentAudio", minCount: 3 }],
        },
      }),
    );

    const enough = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);
    expect(enough.status).toBe("succeeded");

    temp.registry.register(
      producing(["SegmentAudio", "SegmentAudio"], {
        id: "stage-b",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "SegmentAudio", minCount: 3 }],
        },
      }),
    );

    const short = await temp.runner.run(temp.manifest.runId, "stage-b", undefined);
    expect(short.status).toBe("failed");
    expect(short.error?.message).toContain("2 time(s)");
  });

  it("7. a failed attempt keeps its partial registrations and is not held to the contract", async () => {
    // §19.1's recovery from partial success. A stage that stopped halfway owes nothing —
    // demanding a complete artifact set from an incomplete attempt would turn one failure into
    // two, and the artifacts it did produce are the evidence of how far it got.
    temp.registry.register(
      aStage({
        id: "stage-a",
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "SegmentAudio", minCount: 3 }],
        },
        idempotency: { kind: "not_idempotent", reason: "writes files" },
        execute: async (context) => {
          context.recordOutput(anArtifact({ kind: "SegmentAudio" }));
          throw new Error("failed after producing one of three");
        },
      }),
    );

    const result = await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect(result.status).toBe("failed");
    // The failure is the stage's own, not the contract's — the contract was never applied.
    expect(result.error?.code).not.toBe("ALDUS_STAGE_ARTIFACT_CONTRACT_UNMET");
    expect(result.outputArtifacts).toHaveLength(1);
  });

  it("8. the resolved expectation is persisted on the attempt", async () => {
    // §20 asks what the runner expected *at that time*. The expectation comes from a function
    // whose answer changes with a later edit, so a trace holding only the outcome could not tell
    // "the stage failed to produce it" from "the rule changed afterwards".
    temp.registry.register(
      producing(["RenderManifest"], {
        artifacts: {
          produces: "declared",
          resolve: () => [{ kind: "RenderManifest", minCount: 1, maxCount: 2 }],
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    const stored = await temp.runner.stageExecution(temp.manifest.runId, "stage-a");
    expect(stored?.execution.attempts.at(-1)?.expectedArtifacts).toEqual([
      { kind: "RenderManifest", minCount: 1, maxCount: 2 },
    ]);
  });

  it("refuses a definition that declares nothing, rather than assuming none", async () => {
    // The rule the whole ruling rests on: an absent declaration must never be read as "no
    // artifacts". The type requires it; this catches the definition built from configuration or
    // handed over by a JavaScript adopter, which is how one would actually arrive.
    const undeclared = aStage({ id: "stage-a" }) as unknown as Record<string, unknown>;
    delete undeclared["artifacts"];

    expect(() => temp.registry.register(undeclared as never)).toThrowError(
      /ALDUS_STAGE_ARTIFACT_DECLARATION_REQUIRED|declares nothing about the artifacts/,
    );
  });

  it("does not let the resolver see what the stage produced", async () => {
    // The constraint that makes the rest worth anything: an obligation derived from the result is
    // satisfied by construction, and the defect would define away its own postcondition.
    let seen: readonly string[] = [];
    temp.registry.register(
      producing(["RenderManifest"], {
        artifacts: {
          produces: "declared",
          resolve: (context: Record<string, unknown>) => {
            seen = Object.keys(context);
            return [{ kind: "RenderManifest", minCount: 1 }];
          },
        },
      }),
    );

    await temp.runner.run(temp.manifest.runId, "stage-a", undefined);

    expect([...seen].sort()).toEqual(["configuration", "input", "inputArtifacts"]);
  });
});
