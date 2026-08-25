import { beforeEach, describe, expect, it } from "vitest";

import { GateRegistry } from "../src/definition.js";
import { GateEngine } from "../src/engine.js";
import { GateEngineErrorCodes } from "../src/errors.js";
import { MemoryGateDecisionStore, MemoryGateEventSink } from "../src/ports.js";
import {
  AT,
  CONTENT_FREEZE,
  EPISODE_ID,
  OPERATOR,
  RUN_ID,
  standardGates,
  standardSubjects,
} from "./helpers.js";

/**
 * A waiver is not an approval, and two refusals are what keep it from becoming one (§13).
 *
 * `waived` was always a first-class decision; what it lacked was a door and these two rules. An
 * operator who cannot honestly approve a gate had only two shapes available — widen the gate's
 * permitted actors, or approve something they did not judge — and both record a decision that
 * misdescribes what happened.
 */

let engine: GateEngine;

beforeEach(() => {
  engine = new GateEngine({
    registry: GateRegistry.from(standardGates()),
    decisions: new MemoryGateDecisionStore(),
    events: new MemoryGateEventSink(),
  });
});

const waive = (over: Record<string, unknown> = {}) =>
  engine.decide({
    runId: RUN_ID,
    gateId: CONTENT_FREEZE,
    decision: "waived",
    comment: "The oracle is unavailable and this episode is a rerun.",
    subjects: standardSubjects()[CONTENT_FREEZE] ?? [],
    decidedBy: OPERATOR,
    decidedAt: AT,
    episodeId: EPISODE_ID,
    ...over,
  });

const codeOf = (thrown: unknown): string =>
  typeof thrown === "object" && thrown !== null && "code" in thrown
    ? String((thrown as { code: unknown }).code)
    : `not an AldusError: ${String(thrown)}`;

describe("a waiver must say why", () => {
  it("is recorded when it carries a reason", async () => {
    // The positive control. Without it, the refusals below could be measuring the fixture.
    const decision = await waive();
    expect(decision.decision).toBe("waived");
    expect(decision.comment).toContain("rerun");
  });

  it("is refused with no reason at all", async () => {
    await expect(waive({ comment: undefined })).rejects.toSatisfy(
      (thrown) => codeOf(thrown) === GateEngineErrorCodes.GATE_WAIVER_INVALID,
    );
  });

  it("is refused with a blank one, which is the same absence wearing a string", async () => {
    await expect(waive({ comment: "   " })).rejects.toSatisfy(
      (thrown) => codeOf(thrown) === GateEngineErrorCodes.GATE_WAIVER_INVALID,
    );
  });
});

describe("a waiver cannot outlive the content it was granted against", () => {
  it("expires on change even where the gate's own default says it should not", async () => {
    // The whole design rests on this. Every gate being waivable — `release.public` included — is
    // defensible only because a waiver dies when its subjects move.
    //
    // Against a gate whose default is already `true` this assertion passes whether or not the rule
    // exists, which is how the first version of this test reported a surviving mutant as fine. The
    // gate below declares `expiresOnChange: false`, so only the forcing can produce `true`.
    const lenient = new GateEngine({
      registry: GateRegistry.from(
        standardGates().map((gate) =>
          gate.gateId === CONTENT_FREEZE ? { ...gate, expiresOnChange: false } : gate,
        ),
      ),
      decisions: new MemoryGateDecisionStore(),
      events: new MemoryGateEventSink(),
    });

    // The control: an approval on that same gate still takes the lenient default.
    const approved = await lenient.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "approved",
      subjects: standardSubjects()[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
    });
    expect(approved.expiresOnChange).toBe(false);

    const waived = await lenient.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "waived",
      comment: "The oracle is unavailable and this episode is a rerun.",
      subjects: standardSubjects()[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
    });
    expect(waived.expiresOnChange).toBe(true);
  });

  it("refuses a caller asking for a non-expiring waiver", async () => {
    // `expiresOnChange: false` is a legitimate per-decision override for an *approval* whose
    // subject cannot drift. On a waiver it is a disabled gate reached through the decision API
    // instead of the config file.
    await expect(waive({ expiresOnChange: false })).rejects.toSatisfy(
      (thrown) => codeOf(thrown) === GateEngineErrorCodes.GATE_WAIVER_INVALID,
    );
  });

  it("still records an approval's own override, so the rule did not widen", async () => {
    // The control in the other direction: this refusal must not have leaked onto approvals.
    const decision = await engine.decide({
      runId: RUN_ID,
      gateId: CONTENT_FREEZE,
      decision: "approved",
      expiresOnChange: false,
      subjects: standardSubjects()[CONTENT_FREEZE] ?? [],
      decidedBy: OPERATOR,
      decidedAt: AT,
      episodeId: EPISODE_ID,
    });
    expect(decision.expiresOnChange).toBe(false);
  });
});
