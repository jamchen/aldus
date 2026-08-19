/**
 * Which gates gate which stages (architecture contract §11, ADR-0021).
 *
 * The regression these pin: before ADR-0021 the policy picked one blocking gate with
 * `gates.find((gate) => gate.blocking)` and applied it to *every* unrun stage, because nothing in
 * the model said which gates gate which stages. A realistic workflow declares its gates up front,
 * so `next` was empty from the first moment of a Run, and §24's promise — "current state and next
 * safe action" — degraded to "here is why you cannot act".
 *
 * The first test reproduces the old behaviour deliberately, because the fix is opt-in: a workflow
 * that declares no association must keep behaving exactly as it did.
 */

import { describe, expect, it } from "vitest";

import { decideActions, type ActionPolicyInput } from "../src/nextaction.js";

import { gateStatus } from "./helpers.js";

const run = { runId: "run-a", status: "running" as const };

function plan(input: Partial<ActionPolicyInput> = {}) {
  return decideActions({ run, stages: [], gates: [], ...input });
}

/** A satisfied gate stops nothing, so `blocking` is false as the engine would report it. */
function satisfied(gateId: string) {
  return gateStatus({ gateId, state: "satisfied", blocking: false });
}

/** One satisfied gate and one unrelated pending gate — the shape that exposed the defect. */
const twoGates = [satisfied("content-freeze"), gateStatus({ gateId: "release-publish" })];

describe("no association declared", () => {
  it("keeps the pre-ADR-0021 behaviour, blocking every unrun stage", () => {
    // Backward compatibility asserted rather than assumed.
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run" }],
      gates: twoGates,
    });

    // The stage stays blocked, which is what this test is about. What changed with #86 is that
    // the gate holding it up is now offered: telling an operator "release-publish blocks
    // narration" while also telling them there is nothing to do is incoherent, and the second
    // half was the false one.
    expect(result.next.map((action) => action.gateId)).toEqual(["release-publish"]);
    expect(result.next.every((action) => action.stageId === undefined)).toBe(true);
    const blocked = result.blocked.find((entry) => entry.stageId === "narration");
    expect(blocked?.gateId).toBe("release-publish");
    // No mention of a graph: none was declared, and suggesting one here would be noise.
    expect(blocked?.reason).not.toMatch(/workflow graph/i);
  });
});

describe("a stage that declares its gates", () => {
  it("is offered when its required gate is satisfied, despite an unrelated pending gate", () => {
    // This is the fix. `release-publish` is pending and blocking; it does not gate this stage.
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run", requiredGates: ["content-freeze"] }],
      gates: twoGates,
    });

    expect(result.next.map((action) => action.stageId)).toEqual(["narration"]);
  });

  it("is offered when it declares it requires no gate at all", () => {
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run", requiredGates: [] }],
      gates: twoGates,
    });

    expect(result.next.map((action) => action.stageId)).toEqual(["narration"]);
  });

  it("is blocked when its required gate is unsatisfied, and that gate is named", () => {
    const result = plan({
      stages: [
        { stageId: "publish-step", status: "never_run", requiredGates: ["release-publish"] },
      ],
      gates: twoGates,
    });

    // No stage is offered — the stage is genuinely blocked. The gate it requires is offered,
    // because deciding it is the operator's next action (#86).
    expect(result.next.map((action) => action.stageId)).toEqual([undefined]);
    expect(result.next.map((action) => action.gateId)).toEqual(["release-publish"]);
    const blocked = result.blocked.find((entry) => entry.stageId === "publish-step");
    expect(blocked?.gateId).toBe("release-publish");
    expect(blocked?.reason).toContain("requires it");
  });

  it("names the gate it requires, not whichever blocking gate comes first", () => {
    // Two blocking gates. A stage requiring the second must not be told about the first — that
    // was the old behaviour, and it sent an operator to decide something irrelevant.
    const result = plan({
      stages: [{ stageId: "publish-step", status: "never_run", requiredGates: ["gate-b"] }],
      gates: [
        gateStatus({ gateId: "gate-a", state: "pending" }),
        gateStatus({ gateId: "gate-b", state: "rejected" }),
      ],
    });

    expect(result.blocked.find((entry) => entry.stageId === "publish-step")?.gateId).toBe("gate-b");
  });

  it("is not blocked by an advisory gate it names (§12)", () => {
    // §12 level 2 reports without blocking, so a pending advisory gate must not stop work even
    // when a stage names it.
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run", requiredGates: ["rhythm-advice"] }],
      gates: [
        gateStatus({
          gateId: "rhythm-advice",
          state: "pending",
          enforcement: "advisory",
          blocking: false,
        }),
      ],
    });

    expect(result.next.map((action) => action.stageId)).toEqual(["narration"]);
  });

  it("is blocked when it requires a gate nobody registered", () => {
    // An unregistered requirement can never be satisfied. Ignoring it would run a stage whose
    // gate the adopter believes is protecting it.
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run", requiredGates: ["ghost-gate"] }],
      gates: twoGates,
    });

    expect(result.next).toEqual([]);
    const blocked = result.blocked.find((entry) => entry.stageId === "narration");
    expect(blocked?.gateId).toBe("ghost-gate");
    expect(blocked?.reason).toMatch(/not registered/i);
  });
});

describe("a stage left out of a graph that declares others", () => {
  it("is blocked conservatively, and the reason says it is undeclared", () => {
    // Silently unblocking an omitted stage would let a mistake in the graph grant work — the
    // worse failure. Blocking it is safe; saying why is what makes the omission fixable rather
    // than mysterious.
    const result = plan({
      stages: [
        { stageId: "declared", status: "never_run", requiredGates: ["content-freeze"] },
        { stageId: "forgotten", status: "never_run" },
      ],
      gates: twoGates,
    });

    // "declared" is offered; "forgotten" is not. The gate holding "forgotten" up is offered
    // alongside it (#86), so filter to stage actions to keep this test about the omission.
    expect(
      result.next.filter((action) => action.kind === "run-stage").map((a) => a.stageId),
    ).toEqual(["declared"]);
    const blocked = result.blocked.find((entry) => entry.stageId === "forgotten");
    expect(blocked?.reason).toMatch(/not declared in the workflow graph/i);
  });
});

describe("the association narrows blocking without reordering priorities", () => {
  it("still puts a halted gate ahead of an unblocked stage", () => {
    const result = plan({
      stages: [
        { stageId: "narration", status: "never_run", requiredGates: [] },
        { stageId: "render", status: "waiting_for_gate", gateId: "content-freeze" },
      ],
      gates: [gateStatus({ gateId: "content-freeze", state: "pending" })],
    });

    expect(result.next.map((action) => action.kind)).toEqual(["approve-gate", "run-stage"]);
  });

  it("still puts a stale approval first", () => {
    const result = plan({
      stages: [{ stageId: "narration", status: "never_run", requiredGates: [] }],
      gates: [gateStatus({ gateId: "content-freeze", state: "stale" })],
    });

    expect(result.next[0]?.kind).toBe("approve-gate");
    expect(result.next[0]?.gateId).toBe("content-freeze");
  });

  it("still puts a retryable failure ahead of an unrun stage", () => {
    const result = plan({
      stages: [
        { stageId: "narration", status: "never_run", requiredGates: [] },
        { stageId: "render", status: "failed", retryable: true, attempt: 1, requiredGates: [] },
      ],
      gates: [],
    });

    expect(result.next.map((action) => action.kind)).toEqual(["retry-stage", "run-stage"]);
  });

  it("still never offers a gate that is blocked upstream", () => {
    const result = plan({
      stages: [
        { stageId: "narration", status: "waiting_for_gate", gateId: "release-publish" },
        { stageId: "other", status: "never_run", requiredGates: [] },
      ],
      gates: [
        gateStatus({
          gateId: "release-publish",
          state: "blocked_upstream",
          blockedBy: ["release-upload"],
        }),
      ],
    });

    expect(result.next.map((action) => action.kind)).toEqual(["run-stage"]);
    expect(
      result.blocked.some(
        (entry) =>
          entry.gateId === "release-publish" && /must be satisfied first/i.test(entry.reason),
      ),
    ).toBe(true);
  });
});

describe("a gate nobody has decided is a next action (#86)", () => {
  /**
   * `status` reported "nothing is currently safe to do" on a Run whose only outstanding item was
   * a pending, blocking, decidable gate — while the thing the Run was waiting for was the
   * operator. Not an omitted item but an omitted category: §13 makes deciding gates the
   * operator's central act.
   *
   * The runtime already knew how to recommend a gate decision. It did it for a drifted approval
   * and for a stage halted mid-execution. Every gate starts `pending` and only some ever go
   * `stale`, so the two handled cases were the exceptions and this was the rule.
   */
  it("offers the undecided gate that is holding up an otherwise-ready stage", () => {
    const result = plan({
      stages: [{ stageId: "script", status: "never_run", requiredGates: ["topic-select"] }],
      gates: [gateStatus({ gateId: "topic-select", state: "pending" })],
    });

    const offered = result.next.find((action) => action.kind === "approve-gate");
    expect(offered?.gateId).toBe("topic-select");
    expect(offered?.command).toBe("aldus approve topic-select --run run-a");
    // The whole point: `status` must not be able to say there is nothing to do here.
    expect(result.next).not.toEqual([]);
  });

  it("does not offer a gate whose cascade would void the decision", () => {
    // §13.1: deciding a gate blocked upstream is wasted work — the cascade voids it. Reported as
    // blocked with the reason, never urged.
    const result = plan({
      stages: [{ stageId: "publish", status: "never_run", requiredGates: ["release"] }],
      gates: [
        gateStatus({ gateId: "release", state: "blocked_upstream", blockedBy: ["content-freeze"] }),
      ],
    });

    expect(result.next.filter((action) => action.kind === "approve-gate")).toEqual([]);
  });

  it("does not offer a gate when an unrun predecessor still has to produce what it binds", () => {
    // ADR-0028's ordering-before-gates rule, which is what keeps this recommendation honest.
    // Urging a decision whose subjects do not exist yet is worse than premature: it is
    // unsatisfiable, and it is the failure the ordering check was added to prevent.
    const result = plan({
      stages: [
        // Declares it needs no gate: otherwise ADR-0021 blocks it conservatively and the gate
        // reaches the recommendation through *this* stage, which is not what is under test.
        { stageId: "render", status: "never_run", requiredGates: [] },
        {
          stageId: "review",
          status: "never_run",
          after: ["render"],
          requiredGates: ["human-ear"],
        },
      ],
      gates: [gateStatus({ gateId: "human-ear", state: "pending" })],
    });

    expect(result.next.filter((action) => action.kind === "approve-gate")).toEqual([]);
    // Running the predecessor is what makes progress, and that is what is offered.
    expect(result.next.map((action) => action.stageId)).toEqual(["render"]);
  });

  it("does not offer an advisory gate, because an advisory gate blocks nothing", () => {
    // This pins the invariant the recommendation relies on rather than a second guard beside it:
    // an advisory gate never becomes a stage blocker, so it never reaches the set of gates
    // standing in the way. The load-bearing assertion is the first one — if advisory gates ever
    // started blocking, the stage would stop being offered and this fails there first.
    const result = plan({
      stages: [{ stageId: "script", status: "never_run", requiredGates: ["style-note"] }],
      gates: [gateStatus({ gateId: "style-note", state: "pending", blocking: false })],
    });

    expect(result.next.map((action) => action.stageId)).toEqual(["script"]);
    expect(result.next.filter((action) => action.kind === "approve-gate")).toEqual([]);
  });
});
