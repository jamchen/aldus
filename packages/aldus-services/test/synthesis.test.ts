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
import type { TtsRequestPlan } from "@aldus-runtime/tts-ledger";
import {
  compareProducedToRequested,
  producedFinalProviderText,
  producedParameters,
} from "@aldus-runtime/tts-ledger";

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
  options: { subjects?: SubjectsByGate; withGrants?: boolean; plan?: TtsRequestPlan } = {},
): Promise<Harness> {
  // The plan the harness arms must be the plan the test then synthesises. §13.2's approval binds
  // the plan's digests, so a test that varies the plan and leaves the harness on the default one
  // is refused by the gate — correctly, and for a reason unrelated to what it meant to assert.
  const plan = options.plan ?? aPlan();
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
    ).rejects.toMatchObject({
      code: ServiceErrorCodes.ADAPTER_NOT_WIRED,
      // Not `policy`. A policy refusal is something an operator could approve away, and no
      // approval conjures an adapter — so classifying it that way tells a caller it may wait
      // and retry, forever. The code's doc comment always said this; the category disagreed.
      category: "validation",
      retryable: false,
    });
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

describe("what the adapter actually did, where it differs from the plan (#133, ADR-0038)", () => {
  // The reported symptom: an adopter synthesising locally recorded seven takes naming a provider
  // that never made the audio, because the take took its parameters from the plan and the adapter
  // had no channel to say otherwise. Each record was individually well-formed, which is why no
  // amount of reading one of them surfaced it.

  it("records the parameters the adapter reports, beside the plan's", async () => {
    const harness = await armed();
    await approveSynthesis(harness);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-b", voice: "voice-b", model: "model-b" },
      productionReason: "synthesised locally; the planned provider was not called",
    };

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    // Beside, not over. The plan's value is still there and still says what was planned.
    expect(take.parameters.provider).toBe("provider-a");
    expect(take.produced?.parameters?.provider).toBe("provider-b");
    // And the question the adopter was actually asking has a right answer.
    expect(producedParameters(take)?.provider).toBe("provider-b");
    expect(compareProducedToRequested(take)).toEqual({
      status: "diverged",
      fields: ["parameters"],
    });
  });

  it("records the string the adapter says it sent, beside the planned one", async () => {
    // The second instance, in the same adapter: a local engine cannot read the performance tags a
    // hosted model consumes and speaks them aloud, so the adapter strips them before synthesis.
    const tagged = aPlan({
      segments: [
        {
          segmentId: "seg-1",
          text: { raw: "The first line.", finalProviderText: "[tag] The first line." },
          estimatedCost: { amount: "0.0100", currency: "USD" },
        },
      ],
    } as never);
    const harness = await armed({ plan: tagged });
    await approveSynthesis(harness);
    harness.synthesis.observation = { producedFinalProviderText: "The first line." };

    const result = await harness.services.synthesiseSegment({
      plan: tagged,
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    expect(take.text.finalProviderText).toBe("[tag] The first line.");
    expect(producedFinalProviderText(take)).toBe("The first line.");
    expect(compareProducedToRequested(take)).toEqual({ status: "diverged", fields: ["text"] });
  });

  it("leaves the take unchanged when the adapter reports nothing", async () => {
    // The ordinary adapter, and the compatibility case. `observed` is absent rather than present
    // and empty, so "did not report" stays distinguishable from "reported that it matched" — the
    // second is a claim and the first is a silence, and only one of them is evidence.
    const harness = await armed();
    await approveSynthesis(harness);

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    const take = result.data.take;

    expect(take.produced).toBeUndefined();
    // Unknown, not "matches". An adapter that never learned to report is indistinguishable from
    // one that produced exactly what was planned, and the earlier draft of this returned the
    // plan's parameters here — stating the second while establishing only the first.
    expect(producedParameters(take)).toBeUndefined();
    expect(compareProducedToRequested(take)).toEqual({ status: "unknown" });
  });

  it("reports no divergence when the adapter reports the same values it was given", async () => {
    // An adapter that echoes its request is saying "I did what you asked", which is a claim worth
    // storing and not a divergence. Asserted because the obvious implementation — treating any
    // observation as a divergence — passes every other test in this block.
    const harness = await armed();
    await approveSynthesis(harness);
    harness.synthesis.observation = {
      producedParameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    };

    const result = await harness.services.synthesiseSegment({
      plan: aPlan(),
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");
    expect(result.data.take.produced?.parameters).toBeDefined();
    expect(compareProducedToRequested(result.data.take)).toEqual({ status: "matches" });
  });
});

describe("synthesis billing reaches a Runtime-owned cost record (#160)", () => {
  // The gap: `SynthesisGateway` copied an adapter-supplied `costRecordId` and nothing else, so an
  // adapter that knew what it was charged had no way to say so — and an approved USD ceiling had
  // nothing to consume.

  const charged = {
    provider: "provider-a",
    operation: "synthesis",
    billingStatus: "charged" as const,
    actual: { amount: "0.2500", currency: "USD" },
  };

  /** Costs as the Run actually holds them, read through the same collection `aldus costs` reads. */
  const recordedCosts = (harness: Harness) =>
    harness.context.workspace.runs.listRecords(RUN_ID, "costs");

  it("attributes the adapter's observation with runtime-owned identity", async () => {
    const plan = aPlan();
    const harness = await armed({ plan });
    const decisionId = await approveSynthesis(harness);
    harness.synthesis.observation = { costs: [charged] };

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    const records = await recordedCosts(harness);
    expect(records).toHaveLength(1);
    // The adapter reported billing facts; the Runtime stated who authorized it and which take.
    expect(records[0]?.provider).toBe("provider-a");
    // The **decision that authorized dispatch**, not anything the adapter supplied. Asserted by
    // value because a mutation sourcing this from the adapter's own request id passed a check that
    // only asked whether the field was populated — which is the silent budget-bypass class #107
    // reported, one field over.
    expect(records[0]?.authorizationId).toBe(decisionId);
    expect(records[0]?.takeId).toBe(result.data.take.takeId);
  });

  it("links the take and its costs in both directions", async () => {
    // One synthesis may report several observations, so the canonical link cannot be singular.
    const plan = aPlan();
    const harness = await armed({ plan });
    await approveSynthesis(harness);
    harness.synthesis.observation = {
      costs: [charged, { ...charged, operation: "synthesis.model" }],
    };

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    const records = await recordedCosts(harness);
    expect(records).toHaveLength(2);
    expect(result.data.take.costIds).toEqual(records.map((record) => record.costId));
    for (const record of records) expect(record.takeId).toBe(result.data.take.takeId);
  });

  it("makes the charge durable before the take exists", async () => {
    // Ordering is the contract. A take recorded first would say the work settled while the charge
    // that paid for it is absent, and under-reporting spend is the direction that matters. The
    // cost ids are derived from the preallocated take, which is only possible if the take identity
    // existed before the costs were written.
    const plan = aPlan();
    const harness = await armed({ plan });
    await approveSynthesis(harness);
    harness.synthesis.observation = { costs: [charged] };

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    const records = await recordedCosts(harness);
    // The evidence is that the cost record **names the take**, which is only possible if the take
    // identity existed before the charge was written. The cost id itself is derived from the
    // reservation, because settlement owns the ids and theirs are stable across a retry — a
    // stronger property than deriving them from the take.
    expect(records[0]?.takeId).toBe(result.data.take.takeId);
  });

  it("keeps credits as a quantity, and says the money amount is unknown", async () => {
    // An adapter billed in credits reports them as a quantity: converting to an ISO currency would
    // manufacture a number nobody can reconcile against a provider statement.
    //
    // Which makes it an **unknown-money** charge, not a `charged` one. #150's rule is that a
    // charge states an amount or states that the amount is unknown, and 1200 credits is not an
    // amount of money. `charged` with no `Money` is refused by the schema, correctly — this test
    // asserted it and was wrong, not the code.
    //
    // The consequence is right too: the grant becomes indeterminate, because a USD ceiling cannot
    // be drawn down by credits and pretending otherwise is the conversion this forbids.
    const plan = aPlan();
    const harness = await armed({ plan });
    await approveSynthesis(harness);
    harness.synthesis.observation = {
      costs: [
        {
          provider: "provider-a",
          operation: "synthesis",
          billingStatus: "unknown",
          quantity: { unit: "credits", amount: 1200 },
        },
      ],
    };

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    const record = (await recordedCosts(harness))[0];
    expect(record?.quantity).toEqual({ unit: "credits", amount: 1200 });
    expect(record?.actual).toBeUndefined();
    expect(record?.estimated).toBeUndefined();
  });
});

describe("synthesis reserves before dispatch (#155 step 4)", () => {
  it("commits a reservation before the adapter is called, and settles it after", async () => {
    const plan = aPlan();
    const harness = await armed({ plan });
    await approveSynthesis(harness);
    harness.synthesis.observation = {
      costs: [
        {
          provider: "provider-a",
          operation: "synthesis",
          billingStatus: "charged",
          actual: { amount: "0.0100", currency: "USD" },
        },
      ],
    };

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    if (result.outcome !== "ok") throw new Error("synthesis should have been permitted");

    // The cost record names the reservation, which only exists if one was committed before the
    // effect: the reservation is created before dispatch and its id is derived from nothing the
    // adapter supplied.
    const records = await harness.context.workspace.runs.listRecords(RUN_ID, "costs");
    expect(records[0]?.reservationId).toBeTruthy();
    expect(records[0]?.costId).toBe(`${records[0]?.reservationId}:cost:0`);
  });

  it("refuses before calling the adapter on a condition only the reservation checks", async () => {
    // A refusal that arrives once the provider has been billed is not a refusal.
    //
    // The condition is deliberately one the *older* authorization path does not catch: an
    // unestimated segment against a grant that does not permit unestimated dispatch. A test using
    // an exhausted ceiling passed even with the reservation refusal disabled, because
    // `authorizeSpend` refused it too — so it proved the old check, not the new one.
    const plan = aPlan({
      segments: [{ segmentId: "seg-1", text: { raw: "The first line." } }],
    } as never);
    const harness = await armed({ plan });
    await approveSynthesis(harness);

    const result = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("refused");
    expect(harness.synthesis.calls).toHaveLength(0);
  });

  it("leaves the reservation unresolved when the adapter reports no billing at all", async () => {
    // Dispatched and told nothing is uncertainty, not zero. The reservation stays committed and
    // the grant becomes indeterminate, which is what stops the next segment spending against a
    // figure nobody can establish.
    const plan = aPlan();
    const harness = await armed({ plan });
    await approveSynthesis(harness);
    harness.synthesis.observation = { costs: [] };

    const first = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(first.outcome).toBe("ok");

    const second = await harness.services.synthesiseSegment({
      plan,
      segmentId: "seg-1",
      actor: OPERATOR,
    });
    expect(second.outcome).toBe("refused");
  });
});
