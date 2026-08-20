/**
 * The seven acceptance cases from the #133 ruling (§13.2, §15; #136, ADR-0038, ADR-0039).
 *
 * One `it` per case, in the ruling's order, so the list is auditable against the ruling rather
 * than merely inspired by it. Two of them — the legacy record and the authorized-but-free take —
 * are the ones most likely to be got wrong, because both pass trivially against an implementation
 * that assumes agreement, which is what shipped before #135.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareProducedToRequested,
  isPaid,
  producedFinalProviderText,
  producedParameters,
  takePaidness,
  takeRecordSchema,
  type TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";
import { SCHEMA_VERSION } from "@aldus-runtime/core";

import type { SpendGrant } from "@aldus-runtime/gate-engine";

import {
  aGrant,
  aPlan,
  aScript,
  makeComposedServices,
  seedRun,
  subjectsForPlan,
  synthesisGate,
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

/** Arm the stack against exactly the plan the test will synthesise (§13.2 binds the plan). */
async function armedFor(
  plan: TtsRequestPlan,
  options: { grant?: Partial<SpendGrant> } = {},
): Promise<Harness> {
  const grant = aGrant({ ...options.grant });
  const harness = makeComposedServices(workspace.workspace, {
    gates: [synthesisGate(plan)],
    subjects: subjectsForPlan(plan, SYNTHESIS_GATE, grant),
  });
  await seedRun(harness.services);
  await harness.services.recordPerformanceScript({ script: aScript(), actor: OPERATOR });
  await harness.services.recordSynthesisPlan({ plan, actor: OPERATOR });
  const approval = await harness.services.approve({
    runId: plan.runId,
    gateId: SYNTHESIS_GATE,
    actor: OPERATOR,
  });
  if (approval.outcome !== "ok") throw new Error("the gate should have been approvable");
  harness.grant.current = { ...grant, decisionId: approval.data.decisionId };
  return harness;
}

async function synthesise(harness: Harness, plan: TtsRequestPlan) {
  const result = await harness.services.synthesiseSegment({
    plan,
    segmentId: "seg-1",
    actor: OPERATOR,
  });
  return result;
}

describe("the seven acceptance cases of the #133 ruling", () => {
  it("1. a plan naming one provider, executed locally by a different engine", async () => {
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-b", voice: "voice-b", model: "model-b" },
      mechanism: "synthesis",
      incurredCharge: false,
      productionReason: "rendered locally; the planned provider was never called",
    };
    harness.synthesis.costRecordId = undefined;

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted: ");
    const take = result.data.take;

    // The requested fact survives untouched — it is still true that this was planned.
    expect(take.parameters.provider).toBe("provider-a");
    // And the question the adopter was actually asking now has an answer.
    expect(producedParameters(take)?.provider).toBe("provider-b");
    expect(compareProducedToRequested(take)).toEqual({
      status: "diverged",
      fields: ["parameters"],
    });
  });

  it("2. performance tags removed before local synthesis", async () => {
    const plan = aPlan({
      segments: [
        {
          segmentId: "seg-1",
          text: { raw: "The first line.", finalProviderText: "[tag] The first line." },
          estimatedCost: { amount: "0.0100", currency: "USD" },
        },
      ],
    } as never);
    const harness = await armedFor(plan);
    harness.synthesis.observation = {
      producedFinalProviderText: "The first line.",
      mechanism: "synthesis",
      incurredCharge: false,
    };
    harness.synthesis.costRecordId = undefined;

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    expect(take.text.finalProviderText).toBe("[tag] The first line.");
    expect(producedFinalProviderText(take)).toBe("The first line.");
    expect(compareProducedToRequested(take)).toEqual({ status: "diverged", fields: ["text"] });
    // Free, so it is not refused — and it says so rather than being silently tolerated.
    expect(takePaidness(take)).toBe("free");
  });

  it("3. replay of audio another provider originally produced", async () => {
    // The case that forces a third fact. The produced parameters are honestly the original
    // provider's — the bytes really were made that way — while the delivery called nobody.
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      mechanism: "replay",
      sourceTakeId: "take-original",
      incurredCharge: false,
    };
    harness.synthesis.costRecordId = undefined;

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    // Produced facts match the plan, because the original synthesis really did use them.
    expect(compareProducedToRequested(take)).toEqual({ status: "matches" });
    // Delivery tells the other half of the truth, which a two-fact model could not hold.
    expect(take.delivery?.mechanism).toBe("replay");
    expect(take.delivery?.sourceTakeId).toBe("take-original");
    expect(takePaidness(take)).toBe("free");
  });

  it("4. a normal request where requested and produced facts match", async () => {
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      mechanism: "synthesis",
      incurredCharge: true,
    };

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    expect(compareProducedToRequested(take)).toEqual({ status: "matches" });
    expect(takePaidness(take)).toBe("paid");
    // Matching is a claim the adapter made, and it is not confused with nobody having spoken.
    expect(take.produced).toBeDefined();
  });

  it("5. a legacy record whose production facts are unknown", async () => {
    // The case that passes trivially against an implementation assuming agreement — which is what
    // shipped in the first draft of ADR-0038 and had to be corrected.
    const legacy = takeRecordSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      takeId: "take-legacy",
      runId: "run-a",
      planId: "plan-a",
      segmentId: "seg-1",
      attempt: 1,
      text: { raw: "The first line.", finalProviderText: "The first line." },
      parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
      authorization: {
        gateId: SYNTHESIS_GATE,
        decisionId: "decision-a",
        planScopeSha256: "c".repeat(64),
      },
      recordedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(producedParameters(legacy)).toBeUndefined();
    expect(producedFinalProviderText(legacy)).toBeUndefined();
    expect(compareProducedToRequested(legacy)).toEqual({ status: "unknown" });
    // Authorized, and nothing establishes that anything was spent.
    expect(takePaidness(legacy)).toBe("unknown");
    expect(isPaid(legacy)).toBe(false);
  });

  it("6a. a paid execution by an adapter that declares it may substitute is refused before the call", async () => {
    // "Rejected before the provider call" is only reachable through a declaration: a divergence is
    // visible after the call, when a paid provider has already been billed.
    const plan = aPlan({
      segments: [
        {
          segmentId: "seg-1",
          text: { raw: "The first line.", finalProviderText: "The first line." },
          estimatedCost: { amount: "0.0100", currency: "USD" },
        },
      ],
    } as never);
    const harness = await armedFor(plan);
    harness.synthesis.declares = { maySubstitute: true, mechanism: "synthesis" };

    const result = await synthesise(harness, plan);

    expect(result.outcome).toBe("refused");
    // The proof that it was refused *before* the call, not after.
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("6c. a free execution by the same declaring adapter is not refused", async () => {
    // The adopter's actual case, and the half a refusal rule gets wrong if it forgets paidness.
    // Their local engine cannot read the performance tags a hosted model consumes and speaks them
    // aloud, so their adapter strips them and declares that it may. Refusing that would break the
    // correct case while claiming to protect it.
    //
    // Written because a mutation removing the paidness condition from the pre-call refusal passed
    // every other test in this file.
    // No per-segment estimate, which is what makes this execution free rather than paid — the
    // pre-call refusal turns on paidness, and adding an estimate to the shared fixture would have
    // quietly converted this case into the one it is contrasted with.
    const plan = aPlan({
      segments: [{ segmentId: "seg-1", text: { raw: "The first line." } }],
    } as never);
    const harness = await armedFor(plan, {
      // Unestimated dispatch has to be permitted for a reservation to exist at all, and the
      // permission is only satisfiable with a per-request ceiling to reserve — a grant that
      // permits it and states no ceiling promises an amount it does not have (ADR-0044).
      grant: {
        unestimatedExecution: "reserve_max_per_request",
        maxPerRequest: { amount: "1.0000", currency: "USD" },
      },
    });
    harness.synthesis.declares = { maySubstitute: true, mechanism: "synthesis" };
    harness.synthesis.costRecordId = undefined;
    harness.synthesis.observation = {
      producedFinalProviderText: "The first line.",
      incurredCharge: false,
    };

    const result = await synthesise(harness, plan);

    expect(result.outcome).toBe("ok");
    expect(harness.synthesis.calls).toHaveLength(1);
  });

  it("6d. the delivering adapter is named by the gateway, never by the adapter", async () => {
    // §20, and the same rule as `authorizationId` on a cost record: a component that can state its
    // own identity can state a false one, and the gateway holds the true value already.
    //
    // Also written because of a surviving mutation — one that sourced `adapterId` from the
    // outcome passed every test here, since none of them looked at it.
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = { mechanism: "replay", incurredCharge: true };

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    expect(result.data.take.delivery?.adapterId).toBe("adapter-a");
    expect(result.data.take.delivery?.mechanism).toBe("replay");
  });

  it("6b. a paid execution that diverged is recorded without claiming the approval covered it", async () => {
    // The undeclared adapter. The money is gone, so refusing to record would only make the charge
    // invisible — §20 requires the trace to answer "what it cost". What the record must not do is
    // claim §13.2 was satisfied.
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-b", voice: "voice-b", model: "model-b" },
      incurredCharge: true,
    };

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("the charge should still have been recorded");
    const take = result.data.take;

    expect(take.unauthorizedCharge).toBeDefined();
    expect(take.unauthorizedCharge?.rejectedAuthorizationId).toBeDefined();
    expect(takePaidness(take)).toBe("paid");
  });

  it("7. an authorized but free local take is not classified as paid", async () => {
    // The original defect, stated as its own case. `isPaid` returned true on the presence of an
    // authorization, so an adopter's seven authorized local renders were all counted paid.
    const plan = aPlan();
    const harness = await armedFor(plan);
    harness.synthesis.observation = { mechanism: "synthesis", incurredCharge: false };
    harness.synthesis.costRecordId = undefined;

    const result = await synthesise(harness, plan);
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    expect(take.authorization).toBeDefined();
    expect(takePaidness(take)).toBe("free");
    expect(isPaid(take)).toBe(false);
  });
});
