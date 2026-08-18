import { AldusError } from "@aldus-runtime/core";
import { describe, expect, it } from "vitest";

import { BlindSpotRegistry, blindSpotCoversCase } from "../src/blindspots.js";
import { RegressionErrorCodes } from "../src/errors.js";
import { WHOLE_CORPUS_SLICE } from "../src/scope.js";
import { LABELLER_A } from "./helpers.js";

const base = {
  blindSpotId: "bs-1",
  evaluatorId: "evaluator-a",
  description: "Misses homophone substitution when the segment exceeds thirty seconds.",
  scope: { voice: "voice-a" },
  status: "open" as const,
  evidenceCaseIds: ["case-7"],
  recordedBy: LABELLER_A,
  recordedAt: "2026-01-01T00:00:00.000Z",
};

describe("registry", () => {
  it("records and lists blind spots", () => {
    const registry = BlindSpotRegistry.from([base]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.forEvaluator("evaluator-a")).toHaveLength(1);
    expect(registry.forEvaluator("evaluator-b")).toHaveLength(0);
  });

  it("rejects a malformed record", () => {
    try {
      BlindSpotRegistry.from([{ ...base, status: "invented-status" }]);
      expect.unreachable("expected a malformed error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.BLIND_SPOT_MALFORMED);
    }
  });

  it("rejects a duplicate id", () => {
    try {
      BlindSpotRegistry.from([base, { ...base, description: "Something else." }]);
      expect.unreachable("expected a duplicate error");
    } catch (error) {
      expect((error as AldusError).code).toBe(RegressionErrorCodes.BLIND_SPOT_DUPLICATE);
    }
  });

  it("requires an actor, since §19.2 makes an unattributed record no record at all", () => {
    const { recordedBy: _omitted, ...withoutActor } = base;
    expect(() => BlindSpotRegistry.from([withoutActor])).toThrowError(AldusError);
  });

  it("is serialisable, so persistence is the caller's choice", () => {
    const registry = BlindSpotRegistry.from([base]);
    const round = BlindSpotRegistry.from(JSON.parse(JSON.stringify(registry)) as unknown[]);
    expect(round.list()).toEqual(registry.list());
  });
});

describe("scope applicability", () => {
  const registry = BlindSpotRegistry.from([base]);

  it("applies to the slice it is scoped to", () => {
    expect(
      registry.openFor("evaluator-a", { dimensions: ["voice"], values: { voice: "voice-a" } }),
    ).toHaveLength(1);
  });

  it("does not apply to a sibling value of the same dimension", () => {
    expect(
      registry.openFor("evaluator-a", { dimensions: ["voice"], values: { voice: "voice-b" } }),
    ).toHaveLength(0);
  });

  // The whole corpus contains the affected voice, so a blind spot on that voice is live there.
  // Requiring an exact scope match would let the aggregate slice look clean while a known
  // failure sat inside it.
  it("applies to a broader slice that contains it", () => {
    expect(registry.openFor("evaluator-a", WHOLE_CORPUS_SLICE)).toHaveLength(1);
  });

  it("applies to a slice that holds an unrelated dimension", () => {
    expect(
      registry.openFor("evaluator-a", { dimensions: ["host"], values: { host: "example-host" } }),
    ).toHaveLength(1);
  });

  it("ignores mitigated and accepted records when asked for open ones", () => {
    const mixed = BlindSpotRegistry.from([
      { ...base, blindSpotId: "bs-open" },
      { ...base, blindSpotId: "bs-mitigated", status: "mitigated", mitigation: "Second pass." },
      { ...base, blindSpotId: "bs-accepted", status: "accepted" },
    ]);
    expect(mixed.openFor("evaluator-a", WHOLE_CORPUS_SLICE).map((r) => r.blindSpotId)).toEqual([
      "bs-open",
    ]);
    // Accepted stays listed, because tolerating a blind spot is a standing decision, not a fix.
    expect(mixed.list()).toHaveLength(3);
  });

  it("finds blind spots demonstrated by cases in a subset", () => {
    expect(registry.demonstratedBy("evaluator-a", new Set(["case-7"]))).toHaveLength(1);
    expect(registry.demonstratedBy("evaluator-a", new Set(["case-8"]))).toHaveLength(0);
  });

  it("covers a case whose scope satisfies it", () => {
    const record = registry.list()[0]!;
    expect(blindSpotCoversCase(record, { voice: "voice-a", host: "example-host" })).toBe(true);
    expect(blindSpotCoversCase(record, { voice: "voice-b" })).toBe(false);
  });

  it("treats an unscoped blind spot as applying everywhere", () => {
    const global = BlindSpotRegistry.from([{ ...base, scope: {} }]);
    expect(
      global.openFor("evaluator-a", { dimensions: ["voice"], values: { voice: "voice-z" } }),
    ).toHaveLength(1);
  });
});
