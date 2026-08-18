/**
 * The synthesis injection point (contract §13.2, §15, ADR-0015, ADR-0016).
 *
 * These are written as **bypass attempts**, not as a happy path with an assertion appended. The
 * property under test is that the adapter cannot be reached without §13.2's authorization, and the
 * only way to test that is to try to reach it: with no gate, with an unapproved gate, with a gate
 * approved over the wrong subjects, with no spend grant, and with a hand-forged permit.
 *
 * `adapter.calls.length === 0` is what "no money was spent" means. Every refusal below asserts it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SubjectsByGate } from "@aldus-runtime/gate-engine";

import { ServiceErrorCodes } from "../src/errors.js";
import { AldusContext, AldusServices } from "../src/index.js";
import type { SynthesisPermit } from "../src/synthesis.js";
import {
  aGrant,
  aPlan,
  aScript,
  makeComposedServices,
  seedRun,
  subjectsBindingTheWrongPlan,
  subjectsForPlan,
  synthesisGate,
  RUN_ID,
  SYNTHESIS_GATE,
  type Harness,
} from "./composition-helpers.js";
import { makeTempWorkspace, OPERATOR, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** A harness whose synthesis gate is registered, with a Run, a script, and a plan recorded. */
async function armed(
  options: { subjects?: SubjectsByGate; withGrants?: boolean } = {},
): Promise<Harness> {
  const plan = aPlan();
  const harness = makeComposedServices(workspace.workspace, {
    gates: [synthesisGate(plan)],
    subjects: options.subjects ?? subjectsForPlan(plan),
    ...(options.withGrants === undefined ? {} : { withGrants: options.withGrants }),
  });
  await seedRun(harness.services);
  await harness.services.recordPerformanceScript({ script: aScript(), actor: OPERATOR });
  await harness.services.recordSynthesisPlan({ plan, actor: OPERATOR });
  return harness;
}

/**
 * Approve the synthesis gate and put a grant citing that decision in force.
 *
 * Two steps, in this order, because a grant names the decision that authorized it and a decision's
 * id only exists once it is recorded (§13.2, §19.3).
 */
async function approveSynthesis(harness: Harness, grantOverrides = {}): Promise<string> {
  const result = await harness.services.approve({
    runId: RUN_ID,
    gateId: SYNTHESIS_GATE,
    actor: OPERATOR,
  });
  if (result.outcome !== "ok") throw new Error("the gate should have been approvable");
  harness.grant.current = aGrant({ decisionId: result.data.decisionId, ...grantOverrides });
  return result.data.decisionId;
}

describe("reaching the adapter without authorization", () => {
  it("refuses when no gate has been approved, and never calls the adapter", async () => {
    const harness = await armed();

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("refuses when the gate is approved but no ceiling was granted", async () => {
    // §13.2 requires a maximum authorized cost. An approval with no ceiling authorizes nothing, and
    // must not be read as authorizing an unbounded amount.
    const harness = await armed();
    await approveSynthesis(harness);
    harness.grant.current = undefined;

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.explanation).toContain("maximum authorized cost");
    }
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("refuses when no spend authorizer is wired at all", async () => {
    // A ledger with nothing to ask refuses rather than assuming consent.
    const harness = await armed({ withGrants: false });
    await approveSynthesis(harness);

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("refuses a grant citing a superseded decision", async () => {
    // §13.2: a grant from an approval that has been replaced does not carry forward.
    const harness = await armed();
    await approveSynthesis(harness);
    const stale = harness.grant.current;
    await harness.services.approve({ runId: RUN_ID, gateId: SYNTHESIS_GATE, actor: OPERATOR });
    harness.grant.current = stale;

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("refuses an approval that bound something other than this plan", async () => {
    // The hole this closes: a caller wires `subjects` to something unrelated, the gate reads as
    // satisfied, and §13.2's binding exists only as a naming convention. The authorizer checks the
    // decision's own subjectHashes against the plan's required digests rather than trusting the
    // wiring.
    const plan = aPlan();
    const harness = await armed({ subjects: subjectsBindingTheWrongPlan(plan) });
    await approveSynthesis(harness);

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    if (result.outcome === "refused") {
      expect(result.refusal.explanation).toContain("does not bind");
    }
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("refuses once an approved plan has drifted", async () => {
    // §13.2 voids the authorization the moment any bound value moves. The approval was over the
    // original plan; a changed voice is a different plan and must not inherit it.
    const harness = await armed();
    await approveSynthesis(harness);

    const drifted = aPlan({
      parameters: { provider: "provider-a", voice: "voice-b", model: "model-a" },
    });
    const result = await harness.services.synthesiseSegment({
      plan: drifted,
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("throws rather than refusing when no adapter is wired", async () => {
    // A wiring error, not a policy answer: no approval an operator could grant would conjure an
    // adapter, so reporting it as "not permitted right now" would be misleading (ADR-0015).
    const plan = aPlan();
    const harness = makeComposedServices(workspace.workspace, {
      gates: [synthesisGate(plan)],
      subjects: subjectsForPlan(plan),
      withSynthesisAdapter: false,
    });
    await seedRun(harness.services);
    await harness.services.recordSynthesisPlan({ plan, actor: OPERATOR });
    await approveSynthesis(harness);

    await expect(
      harness.services.synthesiseSegment({ plan, segmentId: "seg-1", actor: OPERATOR }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.ADAPTER_NOT_WIRED });
  });

  it("refuses an anonymous synthesis (§19.2)", async () => {
    // No default actor on the context and none supplied per call. §19.2 requires a mutating action
    // to record actor identity, and §3.6 treats an unattributed decision as no decision — so this
    // is refused rather than attributed to a placeholder.
    const anonymous = new AldusServices(new AldusContext({ workspace: workspace.workspace }));

    await expect(
      anonymous.synthesiseSegment({ plan: aPlan(), segmentId: "seg-1" }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.ACTOR_REQUIRED });
  });
});

describe("a forged permit", () => {
  it("is not recognised by the gateway that would have issued it", () => {
    const harness = makeComposedServices(workspace.workspace, {});
    const gateway = harness.context.synthesisFor(aPlan());
    expect(gateway).toBeDefined();

    // The brand symbol is never exported, so naming the type needs a cast — and the cast buys
    // nothing, because membership of the gateway's WeakSet is what is actually checked.
    const forged = {
      runId: RUN_ID,
      planId: "plan-a",
      gateId: SYNTHESIS_GATE,
      decisionId: "decision-a",
      planScopeSha256: "d".repeat(64),
    } as unknown as SynthesisPermit;

    expect(gateway?.isPermitIssued(forged)).toBe(false);
  });
});

describe("synthesis once §13.2 holds", () => {
  it("calls the adapter exactly once and records the take with its authorization", async () => {
    const harness = await armed();
    const decisionId = await approveSynthesis(harness);

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    expect(harness.synthesis.calls).toHaveLength(1);
    if (result.outcome !== "ok") return;

    // The charge is traceable to the approval that permitted it (§19.3).
    expect(result.data.take.authorization?.decisionId).toBe(decisionId);
    expect(result.data.take.authorization?.gateId).toBe(SYNTHESIS_GATE);
    expect(result.data.adapterId).toBe("adapter-a");
  });

  it("hands the adapter a permit the gateway recognises", async () => {
    const harness = await armed();
    await approveSynthesis(harness);
    await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    // The adapter verified its own permit through the gateway. A real adapter should do this, and
    // the harness proves the check is usable rather than decorative.
    expect(harness.synthesis.calls[0]?.permitIssued).toBe(true);
  });

  it("never hands the adapter a provider credential", async () => {
    // §19.2: secrets are referenced, never embedded. The adapter receives the plan's opaque
    // parameters and nothing else; anything secret is the adapter's own to resolve.
    const harness = await armed();
    await approveSynthesis(harness);
    await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    const request = harness.synthesis.calls[0]?.request;
    expect(Object.keys(request?.parameters ?? {}).sort()).toEqual(["model", "provider", "voice"]);
  });

  it("throws on a segment the plan does not contain", async () => {
    const harness = await armed();
    await approveSynthesis(harness);

    await expect(
      harness.services.synthesiseSegment({
        plan: aPlan(),
        segmentId: "seg-absent",
        actor: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.INVALID_REQUEST });
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("persists the take, so a later read sees it (§3.4)", async () => {
    const harness = await armed();
    await approveSynthesis(harness);
    await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    const takes = await harness.services.takes(RUN_ID);
    expect(takes.outcome).toBe("ok");
    if (takes.outcome !== "ok") return;
    expect(takes.data.takes).toHaveLength(1);
    // Synthesised but not yet judged: §13.3 keeps final performance approval human-owned.
    expect(takes.data.awaitingAcceptance).toEqual(["seg-1"]);
  });
});

describe("recordUnauthorizedCharge is not a synthesis path (§13.2, §20)", () => {
  it("records a charge without ever calling the adapter", async () => {
    const harness = await armed();

    const result = await harness.services.recordUnauthorizedCharge({
      plan: aPlan(),
      segmentId: "seg-1",
      take: {
        segmentId: "seg-1",
        text: { raw: "The first line." },
        parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
        costRecordId: "cost-a",
      },
      reason: "A worker called out without checking permitSynthesis.",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    // The whole point: §20 can now answer what it cost, and nothing was synthesised to get there.
    expect(harness.synthesis.calls).toHaveLength(0);
    if (result.outcome !== "ok") return;
    expect(result.data.take.unauthorizedCharge?.reason).toContain("without checking");
    expect(result.data.adapterId).toBe("none");
  });
});
