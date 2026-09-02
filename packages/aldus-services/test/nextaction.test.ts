/**
 * The next-safe-action policy (architecture contract §24).
 *
 * §24's definition of done is that "an operator can see current state and next safe action
 * without reading chat history". These tests are the acceptance criteria for the second half of
 * that sentence, and they check two things a data dump would not:
 *
 * 1. that the *right* action is offered, and offered first when several are safe;
 * 2. that everything withheld comes with a reason — because an operator who expected an action
 *    and does not see it cannot otherwise tell whether the runtime forgot or something is
 *    blocking them.
 */

import { describe, expect, it } from "vitest";

import { decideActions, type ActionPolicyInput } from "../src/nextaction.js";

import { gateStatus } from "./helpers.js";

const run = { runId: "run-a", status: "running" as const };

function plan(input: Partial<ActionPolicyInput> = {}) {
  return decideActions({ run, stages: [], gates: [], ...input });
}

describe("what is safe to do next", () => {
  it("offers an unrun stage when nothing is blocking", () => {
    const result = plan({ stages: [{ stageId: "stage-a", status: "never_run" }] });
    expect(result.next.map((action) => action.kind)).toEqual(["run-stage"]);
    expect(result.next[0]?.stageId).toBe("stage-a");
    expect(result.next[0]?.command).toContain("aldus run stage-a");
  });

  it("offers a retry when the recorded failure is retryable (§19.1)", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "failed", retryable: true, attempt: 1 }],
    });
    expect(result.next.map((action) => action.kind)).toEqual(["retry-stage"]);
  });

  it("offers a decision on the gate a stage is halted at", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "waiting_for_gate", gateId: "content-freeze" }],
      gates: [gateStatus({ gateId: "content-freeze", state: "pending" })],
    });
    expect(result.next.map((action) => action.kind)).toEqual(["approve-gate"]);
    expect(result.next[0]?.gateId).toBe("content-freeze");
  });

  it("says plainly when nothing is outstanding", () => {
    const result = plan({
      run: { runId: "run-a", status: "completed" },
      stages: [{ stageId: "stage-a", status: "succeeded", attempt: 1 }],
    });
    expect(result.next).toEqual([]);
    expect(result.summary).toContain("complete");
  });
});

describe("ordering", () => {
  // §13.1 and §13.2 make a drifted approval void, but it still reads as "approved" to anyone
  // skimming — which is exactly why it must be surfaced above ordinary forward progress.
  it("puts a stale approval above everything else", () => {
    const result = plan({
      stages: [
        { stageId: "stage-a", status: "failed", retryable: true },
        { stageId: "stage-b", status: "never_run" },
      ],
      gates: [
        gateStatus({ gateId: "performance-freeze", state: "stale", currentlyBlocking: true }),
      ],
    });
    expect(result.next[0]?.kind).toBe("approve-gate");
    expect(result.next[0]?.gateId).toBe("performance-freeze");
    expect(result.summary).toContain("Re-approve");
  });

  it("puts a halted gate above a retry, and a retry above an unrun stage", () => {
    const result = plan({
      stages: [
        { stageId: "stage-c", status: "never_run" },
        { stageId: "stage-b", status: "failed", retryable: true },
        { stageId: "stage-a", status: "waiting_for_gate", gateId: "gate-a" },
      ],
      gates: [
        gateStatus({
          gateId: "gate-a",
          state: "pending",
          enforcement: "advisory",
          currentlyBlocking: false,
        }),
      ],
    });
    expect(result.next.map((action) => action.kind)).toEqual([
      "approve-gate",
      "retry-stage",
      "run-stage",
    ]);
  });

  it("orders deterministically when priorities tie", () => {
    const first = plan({
      stages: [
        { stageId: "stage-b", status: "never_run" },
        { stageId: "stage-a", status: "never_run" },
      ],
    });
    const second = plan({
      stages: [
        { stageId: "stage-a", status: "never_run" },
        { stageId: "stage-b", status: "never_run" },
      ],
    });
    expect(first.next.map((a) => a.stageId)).toEqual(second.next.map((a) => a.stageId));
  });
});

describe("what is withheld, and why", () => {
  it("explains a non-retryable failure instead of silently omitting the retry", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "failed", retryable: false }],
    });
    expect(result.next).toEqual([]);
    const blocked = result.blocked.find((entry) => entry.kind === "retry-stage");
    expect(blocked?.reason).toContain("not classified retryable");
  });

  it("explains a claimed stage rather than offering to run it", () => {
    const result = plan({ stages: [{ stageId: "stage-a", status: "running", attempt: 1 }] });
    expect(result.next).toEqual([]);
    const blocked = result.blocked.find((entry) => entry.stageId === "stage-a");
    expect(blocked?.reason).toContain("--force");
  });

  it("explains why a stage cannot run while a blocking gate is unsatisfied (§13)", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "never_run" }],
      gates: [gateStatus({ gateId: "content-freeze", state: "pending" })],
    });
    expect(result.next.some((action) => action.kind === "run-stage")).toBe(false);
    const blocked = result.blocked.find((entry) => entry.kind === "run-stage");
    expect(blocked?.reason).toContain("content-freeze");
  });

  // Deciding a gate whose upstream is unsatisfied would record an approval that §13.1's cascade
  // immediately voids — which teaches an operator that approvals do not stick.
  it("does not offer a gate that is blocked upstream, and names what is blocking it", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "waiting_for_gate", gateId: "performance-freeze" }],
      gates: [
        gateStatus({
          gateId: "performance-freeze",
          state: "blocked_upstream",
          blockedBy: ["content-freeze"],
        }),
      ],
    });
    expect(result.next.some((action) => action.gateId === "performance-freeze")).toBe(false);
    const blocked = result.blocked.find((entry) => entry.gateId === "performance-freeze");
    expect(blocked?.reason).toContain("content-freeze");
    expect(blocked?.reason).toContain("§13.1");
  });

  it("reports a stage halted at a gate nobody registered", () => {
    const result = plan({
      stages: [{ stageId: "stage-a", status: "waiting_for_gate", gateId: "gate-nobody-defined" }],
    });
    const blocked = result.blocked.find((entry) => entry.gateId === "gate-nobody-defined");
    expect(blocked?.reason).toContain("no such gate is registered");
  });

  // An operator wondering "why can I not publish" needs the answer present even when no stage
  // asked for it.
  it("explains operations an unsatisfied gate would authorize, unprompted", () => {
    const result = plan({
      gates: [gateStatus({ gateId: "release-publish", state: "pending" })],
    });
    const blocked = result.blocked.find((entry) => entry.kind === "gate-not-satisfied");
    expect(blocked?.summary).toContain("release-publish");
  });

  it("does not report a satisfied gate as blocking anything", () => {
    const result = plan({
      gates: [
        gateStatus({ gateId: "content-freeze", state: "satisfied", currentlyBlocking: false }),
      ],
    });
    expect(result.blocked).toEqual([]);
  });

  // §12 level 2: an advisory gate "reports a possible issue without blocking".
  it("treats a drifted advisory gate as information, not an urgent action", () => {
    const result = plan({
      gates: [
        gateStatus({
          gateId: "rhythm-check",
          state: "stale",
          enforcement: "advisory",
          currentlyBlocking: false,
        }),
      ],
    });
    expect(result.next).toEqual([]);
    const blocked = result.blocked.find((entry) => entry.gateId === "rhythm-check");
    expect(blocked?.reason).toContain("advisory");
  });
});

describe("the summary sentence", () => {
  // An empty action list is ambiguous on its own: "done" and "everything is blocked" look
  // identical, and an operator must not have to infer which one they are in.
  it("distinguishes completion from being blocked", () => {
    const completed = plan({
      run: { runId: "run-a", status: "completed" },
      stages: [{ stageId: "stage-a", status: "succeeded" }],
    });
    const stuck = plan({
      stages: [{ stageId: "stage-a", status: "failed", retryable: false }],
    });

    expect(completed.summary).toContain("complete");
    expect(stuck.summary).toContain("blocked");
    expect(completed.summary).not.toBe(stuck.summary);
  });

  it("says so when no stages are registered at all", () => {
    expect(plan().summary).toContain("no stages are registered");
  });

  it("reports a cancelled Run as terminal, with no actions and no blocked list", () => {
    const result = plan({
      run: { runId: "run-a", status: "cancelled" },
      stages: [{ stageId: "stage-a", status: "never_run" }],
    });
    expect(result.next).toEqual([]);
    expect(result.blocked).toEqual([]);
    expect(result.summary).toContain("cancelled");
  });

  it("leads with the first action when there is one", () => {
    const result = plan({ stages: [{ stageId: "stage-a", status: "never_run" }] });
    expect(result.summary).toContain("Next:");
    expect(result.summary).toContain("stage-a");
  });
});
