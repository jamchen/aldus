/**
 * Binding a decision to exact inputs (architecture contract §13, §3.6).
 *
 * Drift detection is what turns `subjectHashes` from a stored list into the §13.2 guarantee. The
 * detection must be exact; the key-level attribution is best-effort, and these tests pin which is
 * which so a later refactor does not quietly trade the first for the second.
 */

import { describe, expect, it } from "vitest";

import { buildGateDecision } from "@aldus/testkit";

import {
  assertSubjectsCover,
  detectDrift,
  digestBytes,
  digestSubjectValue,
  toSubjectHashes,
  type GateSubject,
} from "../src/binding.js";
import { validateGateDefinition } from "../src/definition.js";
import { GateEngineErrorCodes } from "../src/errors.js";

const gate = validateGateDefinition({
  gateId: "gate-a",
  level: "human_oracle",
  enforcement: "blocking",
  binds: ["alpha", "beta"],
});

function subject(key: string, value: string): GateSubject {
  return { key, sha256: digestBytes(value) };
}

function decisionBinding(subjects: readonly GateSubject[]) {
  return buildGateDecision({ subjectHashes: toSubjectHashes(subjects) });
}

describe("canonical digests", () => {
  it("is insensitive to object key order", () => {
    // Re-serialising an unchanged settings object in a different key order must not read as a
    // changed bound value and void a valid authorization (§13.2).
    expect(digestSubjectValue({ a: 1, b: 2 })).toBe(digestSubjectValue({ b: 2, a: 1 }));
  });

  it("is sensitive to values, nesting, and array order", () => {
    expect(digestSubjectValue({ a: 1 })).not.toBe(digestSubjectValue({ a: 2 }));
    expect(digestSubjectValue({ a: { b: 1 } })).not.toBe(digestSubjectValue({ a: { b: 2 } }));
    expect(digestSubjectValue([1, 2])).not.toBe(digestSubjectValue([2, 1]));
  });

  it("treats an absent property and an explicit undefined alike", () => {
    expect(digestSubjectValue({ a: 1, b: undefined })).toBe(digestSubjectValue({ a: 1 }));
  });

  it("produces lowercase hex that satisfies Core's sha256Hex", () => {
    expect(digestBytes("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("subject coverage (§13.2)", () => {
  it("accepts exactly what the gate binds", () => {
    expect(() =>
      assertSubjectsCover(gate, [subject("alpha", "1"), subject("beta", "2")]),
    ).not.toThrow();
  });

  it("refuses a missing subject", () => {
    // §13.2 requires the operator to approve every listed value. An authorization silently
    // omitting one binds less than the contract requires while still reading as valid.
    expect(() => assertSubjectsCover(gate, [subject("alpha", "1")])).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE }) as Error,
    );
  });

  it("refuses an unexpected subject", () => {
    expect(() =>
      assertSubjectsCover(gate, [
        subject("alpha", "1"),
        subject("beta", "2"),
        subject("gamma", "3"),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE }) as Error,
    );
  });

  it("refuses a duplicated subject key", () => {
    expect(() =>
      assertSubjectsCover(gate, [
        subject("alpha", "1"),
        subject("alpha", "2"),
        subject("beta", "3"),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE }) as Error,
    );
  });

  it("refuses an uppercase digest", () => {
    // Core stores lowercase hex. A mixed-case digest would compare unequal to an identical
    // value and void an approval for no reason.
    expect(() =>
      assertSubjectsCover(gate, [{ key: "alpha", sha256: "A".repeat(64) }, subject("beta", "2")]),
    ).toThrowError(
      expect.objectContaining({ code: GateEngineErrorCodes.GATE_SUBJECTS_INCOMPLETE }) as Error,
    );
  });
});

describe("drift detection", () => {
  const original = [subject("alpha", "1"), subject("beta", "2")];

  it("reports no drift when nothing changed", () => {
    expect(detectDrift(decisionBinding(original), original)).toBeUndefined();
  });

  it("is insensitive to the order subjects are supplied in", () => {
    expect(detectDrift(decisionBinding(original), [...original].reverse())).toBeUndefined();
  });

  it("names the key whose value moved", () => {
    const drift = detectDrift(decisionBinding(original), [
      subject("alpha", "1"),
      subject("beta", "CHANGED"),
    ]);
    expect(drift?.changed).toEqual(["beta"]);
  });

  it("names every key that moved", () => {
    const drift = detectDrift(decisionBinding(original), [
      subject("alpha", "CHANGED"),
      subject("beta", "ALSO"),
    ]);
    expect(drift?.changed.sort()).toEqual(["alpha", "beta"]);
  });

  it("detects a subject that was removed", () => {
    const drift = detectDrift(decisionBinding(original), [subject("alpha", "1")]);
    expect(drift).toBeDefined();
    expect(drift?.orphanedHashes).toHaveLength(1);
  });

  it("detects a subject that was added", () => {
    const drift = detectDrift(decisionBinding(original), [...original, subject("gamma", "3")]);
    expect(drift?.changed).toEqual(["gamma"]);
  });

  // The multiset property. Two subjects sharing a value are two subjects; collapsing them into a
  // set would hide the change when one of them moves.
  it("does not collapse two subjects that share a value", () => {
    const shared = [subject("alpha", "same"), subject("beta", "same")];
    expect(detectDrift(decisionBinding(shared), shared)).toBeUndefined();

    const drift = detectDrift(decisionBinding(shared), [
      subject("alpha", "same"),
      subject("beta", "different"),
    ]);
    expect(drift).toBeDefined();
    expect(drift?.changed).toEqual(["beta"]);
  });

  it("detects the change even when attribution is ambiguous", () => {
    // Both bound to the same value, one changes to the other's value: the multiset still differs,
    // so detection holds. Which key gets named is not guaranteed, and that is documented.
    const shared = [subject("alpha", "x"), subject("beta", "y")];
    const drift = detectDrift(decisionBinding(shared), [
      subject("alpha", "y"),
      subject("beta", "y"),
    ]);
    expect(drift).toBeDefined();
    expect(drift?.changed.length).toBeGreaterThan(0);
  });

  it("compares against the stored hashes regardless of the order they were stored in", () => {
    const unsorted = buildGateDecision({
      subjectHashes: [...toSubjectHashes(original)].reverse(),
    });
    expect(detectDrift(unsorted, original)).toBeUndefined();
  });
});
