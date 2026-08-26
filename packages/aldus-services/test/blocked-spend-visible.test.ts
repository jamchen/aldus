import { describe, expect, it } from "vitest";

import { decideActions } from "../src/nextaction.js";
import type { ActionPolicyInput } from "../src/nextaction.js";

/**
 * Money blocks a stage as surely as a gate does, and the plan knew only about gates (#215).
 *
 * `status` offered a stage the runtime would refuse, because an unresolved charge lives in the
 * reservation store and `decideActions` was a function of stages and gates alone. An operator was
 * sent at a command that fails, for a reason the report already had in hand.
 */

const input = (over: Partial<ActionPolicyInput> = {}): ActionPolicyInput =>
  ({
    run: { runId: "run-a", status: "running" },
    stages: [
      {
        stageId: "script.draft",
        status: "never_run",
        requiredGates: [],
        predecessors: [],
        attempt: 0,
      },
    ],
    gates: [],
    ...over,
  }) as unknown as ActionPolicyInput;

describe("an unresolved charge blocks the plan rather than being invisible to it", () => {
  it("offers the stage when nothing is unresolved", () => {
    // The positive control. Without it, the case below could be measuring a plan that offers
    // nothing for an unrelated reason.
    const plan = decideActions(input());
    expect(plan.next.some((action) => action.kind === "run-stage")).toBe(true);
  });

  it("blocks the stage and names the verb that clears it", () => {
    const plan = decideActions(
      input({ unresolvedSpend: [{ reservationId: "res-abc", operation: "agent.execute" }] }),
    );

    expect(plan.next.some((action) => action.kind === "run-stage")).toBe(false);
    const blocked = plan.blocked.find((action) => action.stageId === "script.draft");
    expect(blocked?.reason).toContain("unresolved charge");
    // The remedy, with the id an operator can copy — not a description of the state.
    expect(blocked?.reason).toContain("aldus costs settle res-abc");
    expect(blocked?.enforcement).toBe("enforced");
  });
});
