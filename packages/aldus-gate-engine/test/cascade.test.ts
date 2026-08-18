/**
 * Cascading invalidation (architecture contract §13.1).
 *
 * > Content Freeze approves the exact spoken content, claims, structure, and host narration. Any
 * > content-changing edit MUST invalidate it and downstream approvals.
 *
 * "And downstream approvals" is the hard half. A Human Ear approval given on audio synthesised
 * from the old script is not merely questionable once the script changes — it approved something
 * that no longer exists, and §24 requires Human Gate decisions to survive Agent session changes,
 * which means they cannot quietly survive content changes too.
 *
 * The cascade is derived on every evaluation rather than written down, so a gate cannot be left
 * marked valid by an interrupted invalidation pass.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { GateSubject } from "../src/binding.js";
import { GateRegistry } from "../src/definition.js";
import { GateEngine } from "../src/engine.js";
import { GateEngineErrorCodes } from "../src/errors.js";
import { MemoryGateDecisionStore, MemoryGateEventSink } from "../src/ports.js";
import {
  AT,
  CONTENT_FREEZE,
  EPISODE_ID,
  HUMAN_EAR,
  OPERATOR,
  PERFORMANCE_FREEZE,
  RELEASE_PUBLISH,
  RELEASE_UPLOAD,
  RUN_ID,
  standardGates,
  standardSubjects,
} from "./helpers.js";

let engine: GateEngine;

beforeEach(() => {
  engine = new GateEngine({
    registry: GateRegistry.from(standardGates()),
    decisions: new MemoryGateDecisionStore(),
    events: new MemoryGateEventSink(),
  });
});

/** Approve every gate in the chain against one set of subjects. */
async function approveAll(subjects: Record<string, ReturnType<typeof standardSubjects>[string]>) {
  for (const gateId of [
    CONTENT_FREEZE,
    PERFORMANCE_FREEZE,
    HUMAN_EAR,
    RELEASE_UPLOAD,
    RELEASE_PUBLISH,
  ]) {
    await engine.decide({
      runId: RUN_ID,
      gateId,
      decision: "approved",
      subjects: subjects[gateId] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: `dec-${gateId}`,
    });
  }
}

describe("a content edit invalidates the freeze and everything downstream", () => {
  it("satisfies the whole chain when nothing has changed", async () => {
    const subjects = standardSubjects();
    await approveAll(subjects);

    const statuses = await engine.evaluate(RUN_ID, subjects);
    for (const gateId of [
      CONTENT_FREEZE,
      PERFORMANCE_FREEZE,
      HUMAN_EAR,
      RELEASE_UPLOAD,
      RELEASE_PUBLISH,
    ]) {
      expect(statuses.get(gateId)?.state, gateId).toBe("satisfied");
    }
  });

  it("invalidates every downstream gate when the spoken text changes", async () => {
    await approveAll(standardSubjects());

    // One edit to the script. Nothing else is touched, and every downstream approval below was
    // given by a human against the old content.
    const statuses = await engine.evaluate(
      RUN_ID,
      standardSubjects({ spokenText: "spokenText-v2" }),
    );

    expect(statuses.get(CONTENT_FREEZE)?.state).toBe("stale");
    // Directly bound to spokenText as well, so it is stale on its own account.
    expect(statuses.get(PERFORMANCE_FREEZE)?.state).toBe("stale");
    // These bind nothing that changed. They are invalid purely by §13.1's cascade.
    expect(statuses.get(HUMAN_EAR)?.state).toBe("blocked_upstream");
    expect(statuses.get(RELEASE_UPLOAD)?.state).toBe("blocked_upstream");
    expect(statuses.get(RELEASE_PUBLISH)?.state).toBe("blocked_upstream");
  });

  it("names what blocked each downstream gate", async () => {
    await approveAll(standardSubjects());
    const statuses = await engine.evaluate(RUN_ID, standardSubjects({ claims: "claims-v2" }));

    expect(statuses.get(HUMAN_EAR)?.blockedBy).toEqual([PERFORMANCE_FREEZE]);
    expect(statuses.get(RELEASE_UPLOAD)?.blockedBy).toEqual([HUMAN_EAR]);
  });

  it("keeps the downstream decisions on record while invalidating them", async () => {
    await approveAll(standardSubjects());
    const statuses = await engine.evaluate(RUN_ID, standardSubjects({ claims: "claims-v2" }));

    // §6.3 makes attempts append-only and §13 makes decisions an audit record: invalidation
    // must not erase the fact that a human approved something, only stop it counting.
    const humanEar = statuses.get(HUMAN_EAR);
    expect(humanEar?.state).toBe("blocked_upstream");
    expect(humanEar?.decision?.decision).toBe("approved");
    expect(humanEar?.decision?.decidedBy).toEqual(OPERATOR);
  });

  it("recovers once the chain is re-approved against the new content", async () => {
    await approveAll(standardSubjects());
    const edited = standardSubjects({ spokenText: "spokenText-v2" });
    await approveAll(edited);

    const statuses = await engine.evaluate(RUN_ID, edited);
    expect(statuses.get(RELEASE_PUBLISH)?.state).toBe("satisfied");
  });

  it("does not invalidate an unrelated branch", async () => {
    // A gate off the dependency chain is untouched by an edit upstream of a different branch.
    const registry = GateRegistry.from([
      ...standardGates(),
      {
        gateId: "thumbnail-review",
        level: "human_oracle",
        enforcement: "blocking",
        binds: ["thumbnail"],
      },
    ]);
    const isolated = new GateEngine({
      registry,
      decisions: new MemoryGateDecisionStore(),
      events: new MemoryGateEventSink(),
    });
    const subjects: Record<string, GateSubject[]> = {
      ...standardSubjects(),
      "thumbnail-review": [{ key: "thumbnail", sha256: "b".repeat(64) }],
    };

    for (const gateId of [CONTENT_FREEZE, "thumbnail-review"]) {
      await isolated.decide({
        runId: RUN_ID,
        gateId,
        decision: "approved",
        subjects: subjects[gateId] ?? [],
        decidedBy: OPERATOR,
        decidedAt: AT,
        episodeId: EPISODE_ID,
        decisionId: `dec-${gateId}`,
      });
    }

    const statuses = await isolated.evaluate(RUN_ID, {
      ...subjects,
      [CONTENT_FREEZE]: standardSubjects({ claims: "claims-v2" })[CONTENT_FREEZE] ?? [],
    });
    expect(statuses.get(CONTENT_FREEZE)?.state).toBe("stale");
    expect(statuses.get("thumbnail-review")?.state).toBe("satisfied");
  });
});

describe("advisory gates do not block (§12 level 2)", () => {
  it("lets a downstream gate stay satisfied when an advisory upstream is pending", async () => {
    // §12 defines an advisory signal as one that "reports a possible issue without blocking".
    // If an un-run advisory halted its downstream gates, every advisory would be a hard gate
    // with a friendlier name and §12's four levels would collapse into two.
    const registry = GateRegistry.from([
      {
        gateId: "rhythm-advice",
        level: "advisory_signal",
        enforcement: "advisory",
        binds: ["script"],
      },
      {
        gateId: "final",
        level: "human_oracle",
        enforcement: "blocking",
        binds: ["render"],
        dependsOn: ["rhythm-advice"],
      },
    ]);
    const advisoryEngine = new GateEngine({
      registry,
      decisions: new MemoryGateDecisionStore(),
      events: new MemoryGateEventSink(),
    });
    const subjects = {
      "rhythm-advice": [{ key: "script", sha256: "c".repeat(64) }],
      final: [{ key: "render", sha256: "d".repeat(64) }],
    };

    await advisoryEngine.decide({
      runId: RUN_ID,
      gateId: "final",
      decision: "approved",
      subjects: subjects.final,
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-final",
    });

    const statuses = await advisoryEngine.evaluate(RUN_ID, subjects);
    expect(statuses.get("rhythm-advice")?.state).toBe("pending");
    expect(statuses.get("rhythm-advice")?.blocking).toBe(false);
    expect(statuses.get("final")?.state).toBe("satisfied");
  });
});

describe("waivers (§13)", () => {
  it("unblocks downstream, because bypassing a check is what a waiver is for", async () => {
    const subjects = standardSubjects();
    await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "waived",
      subjects: subjects[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-waived",
      comment: "Rerun of a previously approved episode.",
    });

    const statuses = await engine.evaluate(RUN_ID, subjects);
    expect(statuses.get(CONTENT_FREEZE)?.state).toBe("waived");
    expect(statuses.get(CONTENT_FREEZE)?.blocking).toBe(false);
    // Distinct from approved, so the bypass stays visible in the record.
    expect(statuses.get(CONTENT_FREEZE)?.decision?.decision).toBe("waived");
  });

  it("still expires when the content it bypassed changes", async () => {
    const subjects = standardSubjects();
    await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "waived",
      subjects: subjects[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-waived",
    });

    // Waiving a check for one version of the content says nothing about the next.
    const statuses = await engine.evaluate(
      RUN_ID,
      standardSubjects({ spokenText: "spokenText-v2" }),
    );
    expect(statuses.get(CONTENT_FREEZE)?.state).toBe("stale");
  });
});

describe("rejections and change requests", () => {
  it.each(["rejected", "changes_requested"] as const)(
    "blocks downstream when %s",
    async (verdict) => {
      const subjects = standardSubjects();
      await engine.decide({
        runId: RUN_ID,
        gateId: CONTENT_FREEZE,
        decision: verdict,
        subjects: subjects[CONTENT_FREEZE] ?? [],
        decidedBy: OPERATOR,
        decidedAt: AT,
        episodeId: EPISODE_ID,
        decisionId: "dec-1",
        comment: "The second claim is unsupported.",
      });

      const statuses = await engine.evaluate(RUN_ID, subjects);
      expect(statuses.get(CONTENT_FREEZE)?.state).toBe(verdict);
      expect(statuses.get(CONTENT_FREEZE)?.explanation).toBe("The second claim is unsupported.");
      expect(statuses.get(PERFORMANCE_FREEZE)?.state).toBe("blocked_upstream");
    },
  );

  it("takes the latest decision in append order, not the latest timestamp", async () => {
    const subjects = standardSubjects();
    await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "rejected",
      subjects: subjects[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      // A later timestamp on the earlier record: two machines with disagreeing clocks must not
      // be able to reorder which approval is current. The append-only log is the durable fact.
      decidedAt: "2026-06-01T00:00:00.000Z",
      episodeId: EPISODE_ID,
      decisionId: "dec-1",
    });
    await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "approved",
      subjects: subjects[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
      decisionId: "dec-2",
    });

    const statuses = await engine.evaluate(RUN_ID, subjects);
    expect(statuses.get(CONTENT_FREEZE)?.state).toBe("satisfied");
    expect(statuses.get(CONTENT_FREEZE)?.decision?.decisionId).toBe("dec-2");
  });
});

describe("dependency graph validation", () => {
  it("refuses a cycle rather than hanging on it", () => {
    expect(() =>
      GateRegistry.from([
        {
          gateId: "a",
          level: "hard_gate",
          enforcement: "blocking",
          binds: ["x"],
          dependsOn: ["b"],
        },
        {
          gateId: "b",
          level: "hard_gate",
          enforcement: "blocking",
          binds: ["x"],
          dependsOn: ["a"],
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEPENDENCY_CYCLE }) as Error,
    );
  });

  it("refuses a self-dependency", () => {
    expect(() =>
      GateRegistry.from([
        {
          gateId: "a",
          level: "hard_gate",
          enforcement: "blocking",
          binds: ["x"],
          dependsOn: ["a"],
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("refuses an edge to a gate that does not exist", () => {
    // An edge to a missing gate would silently drop out of the cascade, which is worse than a
    // loud refusal at configuration time.
    expect(() =>
      GateRegistry.from([
        {
          gateId: "a",
          level: "hard_gate",
          enforcement: "blocking",
          binds: ["x"],
          dependsOn: ["ghost"],
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("reports the full downstream reach of a gate", () => {
    const registry = GateRegistry.from(standardGates());
    expect(registry.downstreamOf(CONTENT_FREEZE)).toEqual([
      PERFORMANCE_FREEZE,
      HUMAN_EAR,
      RELEASE_UPLOAD,
      RELEASE_PUBLISH,
    ]);
    expect(registry.downstreamOf(RELEASE_PUBLISH)).toEqual([]);
  });

  it("handles a diamond without reporting a gate twice", () => {
    const registry = GateRegistry.from([
      { gateId: "root", level: "hard_gate", enforcement: "blocking", binds: ["x"] },
      {
        gateId: "left",
        level: "hard_gate",
        enforcement: "blocking",
        binds: ["x"],
        dependsOn: ["root"],
      },
      {
        gateId: "right",
        level: "hard_gate",
        enforcement: "blocking",
        binds: ["x"],
        dependsOn: ["root"],
      },
      {
        gateId: "join",
        level: "hard_gate",
        enforcement: "blocking",
        binds: ["x"],
        dependsOn: ["left", "right"],
      },
    ]);
    expect(registry.downstreamOf("root")).toEqual(["left", "right", "join"]);
  });
});
