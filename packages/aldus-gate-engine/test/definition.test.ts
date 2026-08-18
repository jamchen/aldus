/**
 * Gate definitions and the §12 quality model.
 *
 * Contract §12 defines four levels and ends with a flat prohibition: "Machine pass MUST NOT be
 * presented as semantic correctness." §12.1 gives the one route by which a machine check may
 * start blocking — "only after it is calibrated against human-labeled examples."
 *
 * These tests pin the structural consequences: an uncalibrated model-assisted evaluator cannot be
 * configured to block, and a human-oracle gate cannot be satisfied by a machine.
 */

import { describe, expect, it } from "vitest";

import { GateRegistry, validateGateDefinition, type GateDefinition } from "../src/definition.js";
import { GateEngineErrorCodes } from "../src/errors.js";

const base: GateDefinition = {
  gateId: "gate-a",
  level: "hard_gate",
  enforcement: "blocking",
  binds: ["subject-a"],
};

describe("evaluator promotion (§12.1)", () => {
  it("refuses a blocking model-assisted gate with no calibration evidence", () => {
    // The whole point of §12.1. Without this, promoting an LLM evaluator to blocking is a
    // one-word config edit, and §12's prohibition becomes a comment rather than a rule.
    expect(() =>
      validateGateDefinition({ ...base, level: "model_assisted", enforcement: "blocking" }),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("allows a model-assisted gate to be advisory without evidence", () => {
    const resolved = validateGateDefinition({
      ...base,
      level: "model_assisted",
      enforcement: "advisory",
    });
    expect(resolved.enforcement).toBe("advisory");
  });

  it("allows promotion once evidence is attached", () => {
    const resolved = validateGateDefinition({
      ...base,
      level: "model_assisted",
      enforcement: "blocking",
      promotionEvidence: {
        reportRef: "calibration-report-a",
        // §12.1 requires scope to be considered: an evaluator calibrated on one host says
        // nothing about another.
        scope: { host: "example-host", voice: "voice-a" },
        knownBlindSpots: ["homophones in proper nouns"],
      },
    });
    expect(resolved.promotionEvidence?.scope).toEqual({ host: "example-host", voice: "voice-a" });
  });

  it("keeps enforcement a two-state field rather than a boolean", () => {
    // A `blocking: boolean` invites a config edit; an enumeration paired with a level and
    // evidence makes promotion a decision someone has to justify.
    const resolved = validateGateDefinition(base);
    expect(["blocking", "advisory"]).toContain(resolved.enforcement);
  });
});

describe("who may decide (§12 level 4, §13.3)", () => {
  it("defaults a human-oracle gate to human decisions only", () => {
    const resolved = validateGateDefinition({ ...base, level: "human_oracle" });
    expect(resolved.permittedActorKinds).toEqual(["human"]);
  });

  it("defaults other levels to any actor", () => {
    const resolved = validateGateDefinition({ ...base, level: "hard_gate" });
    expect(resolved.permittedActorKinds).toContain("worker");
  });

  it("refuses a human-oracle gate that excludes humans", () => {
    expect(() =>
      validateGateDefinition({
        ...base,
        level: "human_oracle",
        permittedActorKinds: ["agent"],
      }),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("refuses a gate no actor may decide", () => {
    expect(() => validateGateDefinition({ ...base, permittedActorKinds: [] })).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });
});

describe("a gate must bind something", () => {
  it("refuses a gate that binds nothing", () => {
    // A gate binding nothing can never be invalidated, so its approval would outlive whatever it
    // approved — exactly what §13.1 and §13.2 exist to prevent.
    expect(() => validateGateDefinition({ ...base, binds: [] })).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("refuses a duplicated subject key", () => {
    expect(() => validateGateDefinition({ ...base, binds: ["a", "a"] })).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("defaults expiresOnChange to true", () => {
    // A gate that silently defaulted to carrying a stale approval forward would be the failure
    // §13.1 and §13.2 describe.
    expect(validateGateDefinition(base).expiresOnChange).toBe(true);
  });
});

describe("the registry", () => {
  it("refuses a duplicate gate id", () => {
    expect(() => GateRegistry.from([base, { ...base }])).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_DEFINITION_INVALID }) as Error,
    );
  });

  it("raises GATE_NOT_FOUND for an unregistered gate", () => {
    const registry = GateRegistry.from([base]);
    expect(() => registry.require("nope")).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_NOT_FOUND }) as Error,
    );
    expect(registry.has("nope")).toBe(false);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("accepts gate ids and subject keys Core has never heard of (§4.2)", () => {
    // The engine must express an adopter's own gates without knowing their names. If this ever
    // needs a change to Core, the boundary has been breached.
    const registry = GateRegistry.from([
      {
        gateId: "an-adopter-specific-gate",
        level: "hard_gate",
        enforcement: "blocking",
        binds: ["some-subject-nobody-anticipated"],
        grants: ["an.operation.core.never.named"],
      },
    ]);
    expect(registry.list()).toHaveLength(1);
  });
});
