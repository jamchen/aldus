/**
 * What a stuck stage's reservations establish about its dispatch window (ADR-0044, #244).
 *
 * The rule these pin is `docs/design/spend-reservation-store.md` §5's row 2 / row 3 distinction:
 * a reservation that merely exists is not proof the provider was called, and one carrying
 * `dispatch_prepared` is proof it **may** have been. Nothing read that fact until now.
 *
 * Every assertion here anchors on the verdict rather than on a substring several verdicts satisfy
 * — #246's surviving mutation was exactly that mistake.
 */

import { describe, expect, it } from "vitest";

import {
  SCHEMA_VERSION,
  SPEND_TRANSITION_KINDS,
  stageDispatchEvidence,
  type SpendReservationTransition,
  type SpendTransitionKind,
} from "../src/index.js";

const RUN = "run-a";
const STAGE = "stage-a";

let sequence = 0;

/** A `reservation.reserved` for a given reservation, defaulting to the stage under test. */
function reserved(
  reservationId: string,
  overrides: {
    grantId?: string;
    runId?: string;
    stageId?: string;
    attemptId?: string;
    effectKey?: string;
  } = {},
): SpendReservationTransition {
  sequence += 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    transitionId: `t-${String(sequence).padStart(4, "0")}`,
    reservationId,
    grantId: overrides.grantId ?? "grant-a",
    kind: "reservation.reserved",
    at: "2026-01-01T00:00:00.000Z",
    detail: {
      authorizationId: "decision-a",
      operation: "operation-a",
      runId: overrides.runId ?? RUN,
      stageId: overrides.stageId ?? STAGE,
      attemptId: overrides.attemptId ?? "att-1",
      effectKey: overrides.effectKey ?? `effect-${reservationId}`,
      reserved: { amount: "12.0000", currency: "USD" },
    },
  };
}

/** Any later transition on a reservation that already exists. */
function later(
  reservationId: string,
  kind: SpendTransitionKind,
  detail: Record<string, unknown> = {},
  grantId = "grant-a",
): SpendReservationTransition {
  sequence += 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    transitionId: `t-${String(sequence).padStart(4, "0")}`,
    reservationId,
    grantId,
    kind,
    at: "2026-01-01T00:01:00.000Z",
    detail,
  };
}

const SCOPE = { runId: RUN, stageId: STAGE };

describe("the safe row — authorization committed, no dispatch recorded", () => {
  it("reads a reservation whose whole stream is one `reserved` as never dispatched", () => {
    expect(stageDispatchEvidence([reserved("res-1")], SCOPE)).toBe("reserved_never_dispatched");
  });

  it("still reads it when a settled reservation of the same stage sits beside it", () => {
    // A retried stage carries history. A terminal reservation consumes no authorization and says
    // nothing about the attempt that is stuck now, so the active one is the whole question.
    const transitions = [
      reserved("res-old"),
      later("res-old", "reservation.dispatch_prepared"),
      later("res-old", "reservation.settled", { costIds: ["cost-1"] }),
      reserved("res-now"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("reserved_never_dispatched");
  });

  it("reads several reservations of one stage as safe only when every one of them is", () => {
    const transitions = [reserved("res-1"), reserved("res-2"), reserved("res-3")];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("reserved_never_dispatched");
  });
});

describe("the dispatch row — a provider call may have gone out", () => {
  it("reads `dispatch_prepared` then nothing as possibly dispatched", () => {
    const transitions = [reserved("res-1"), later("res-1", "reservation.dispatch_prepared")];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("reads `dispatch_identified` with no `dispatch_prepared` between as possibly dispatched", () => {
    // The shape the projection cannot see: `dispatch_identified` is a legal successor of
    // `reserved`, and it leaves `reservation.execution` undefined. A predicate reading
    // `execution !== undefined` would call this stream safe while a provider request id stands on
    // it. The raw stream is the source for exactly this reason.
    const transitions = [
      reserved("res-1"),
      later("res-1", "reservation.dispatch_identified", { providerRequestId: "req-1" }),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("reads a `billing_unknown` reservation as possibly dispatched, not as absent", () => {
    // `billing_unknown` is active — an unknown charge is neither free nor zero — and it is the
    // strongest possible evidence a call went out. Dropping it from the active set would remove
    // the one case where money is known to be at risk.
    const transitions = [
      reserved("res-1"),
      later("res-1", "reservation.dispatch_prepared"),
      later("res-1", "reservation.billing_unknown", { reason: "provider gave no amount" }),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("reads a mix of one reserved-only and one prepared reservation as possibly dispatched", () => {
    // One attempt may hold N reservations — one per independently billed effect (ADR-0043). A
    // per-reservation answer cannot speak for the stage, and the safe one must not outvote the
    // dangerous one.
    const transitions = [
      reserved("res-1"),
      reserved("res-2"),
      later("res-2", "reservation.dispatch_prepared"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("sees a prepared reservation held in a second grant", () => {
    // `reserve` resolves idempotency per grant stream, so one `effectKey` may hold a reservation in
    // each of two grants. Reading one grant and stopping would report safety from half the store.
    const transitions = [
      reserved("res-1"),
      reserved("res-2", { grantId: "grant-b", effectKey: "effect-shared" }),
      later("res-2", "reservation.dispatch_prepared", {}, "grant-b"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });
});

describe("identity — the join is the stage, and it is the only one that does not lie", () => {
  it("sees a reservation carrying an earlier attempt's id", () => {
    // The defect an attempt-scoped query would have. `reserve` returns the existing reservation
    // for a repeated `effectKey` unchanged, so on attempt 10 the reservation still reads `att-1`
    // — and a lookup keyed on the stuck attempt finds nothing while $12 stands committed.
    const transitions = [
      reserved("res-1", { attemptId: "att-1" }),
      later("res-1", "reservation.dispatch_prepared"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("does not let another stage's prepared reservation answer for this one", () => {
    const transitions = [
      reserved("res-1"),
      reserved("res-other", { stageId: "stage-b" }),
      later("res-other", "reservation.dispatch_prepared"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("reserved_never_dispatched");
  });

  it("does not let another Run's prepared reservation answer for this one", () => {
    const transitions = [
      reserved("res-1"),
      reserved("res-other", { runId: "run-b" }),
      later("res-other", "reservation.dispatch_prepared"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("reserved_never_dispatched");
  });

  it("does not answer for a stage whose reservations all belong to another Run", () => {
    const transitions = [
      reserved("res-other", { runId: "run-b" }),
      later("res-other", "reservation.dispatch_prepared"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("indeterminate");
  });
});

describe("indeterminate — the answer when nothing was established", () => {
  it("reads an empty stream as indeterminate, never as safe", () => {
    // A free stage, a workspace that has reserved nothing and a grant nobody could read are
    // indistinguishable here. Calling any of them safe claims a measurement nobody took.
    expect(stageDispatchEvidence([], SCOPE)).toBe("indeterminate");
  });

  it("reads a stage whose only reservations are terminal as indeterminate", () => {
    // Settled and released consume no authorization; the stage that is stuck now holds nothing.
    // The safe row is a claim about active reservations, and there are none to make it about.
    const transitions = [
      reserved("res-1"),
      later("res-1", "reservation.settled", { costIds: ["cost-1"] }),
      reserved("res-2"),
      later("res-2", "reservation.released"),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("indeterminate");
  });
});

describe("source freshness — a kind added later must not default to safe", () => {
  it("treats an unrecognised transition kind as possibly dispatched", () => {
    // The rule is an exclusion — possibly dispatched *unless* the whole stream is one `reserved` —
    // so a kind nobody here has heard of fails closed by construction rather than by someone
    // remembering to add it to a list.
    const transitions = [
      reserved("res-1"),
      later("res-1", "reservation.some_future_kind" as SpendTransitionKind),
    ];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("dispatch_possible");
  });

  it("pins the kinds in force, so adding one forces a decision about which row it belongs to", () => {
    // Not decoration: every kind except `reservation.reserved` currently means the stream is no
    // longer reserved-only. A kind added without reading this rule inherits `dispatch_possible`,
    // which is the safe inheritance — this test exists so that inheritance is a decision.
    expect([...SPEND_TRANSITION_KINDS]).toEqual([
      "reservation.reserved",
      "reservation.dispatch_prepared",
      "reservation.dispatch_identified",
      "reservation.settled",
      "reservation.released",
      "reservation.billing_unknown",
      "reservation.investigation_recorded",
      "reservation.reconciled",
    ]);
  });
});

describe("determinism", () => {
  it("returns one answer for five reads of an unchanged stream", () => {
    const transitions = [
      reserved("res-1"),
      reserved("res-2"),
      later("res-2", "reservation.dispatch_prepared"),
    ];
    const answers = new Set(
      Array.from({ length: 5 }, () => stageDispatchEvidence(transitions, SCOPE)),
    );
    expect([...answers]).toEqual(["dispatch_possible"]);
  });

  it("does not depend on the order grants were read in", () => {
    const a = reserved("res-1");
    const b = reserved("res-2", { grantId: "grant-b" });
    const bPrepared = later("res-2", "reservation.dispatch_prepared", {}, "grant-b");
    expect(stageDispatchEvidence([a, b, bPrepared], SCOPE)).toBe("dispatch_possible");
    expect(stageDispatchEvidence([b, bPrepared, a], SCOPE)).toBe("dispatch_possible");
  });

  it("ignores a transition for a reservation that was never opened", () => {
    // The projection drops an orphan, and so must this: a stream naming a reservation with no
    // `reserved` establishes nothing about a stage it never joined.
    const transitions = [later("res-ghost", "reservation.dispatch_prepared")];
    expect(stageDispatchEvidence(transitions, SCOPE)).toBe("indeterminate");
  });
});
