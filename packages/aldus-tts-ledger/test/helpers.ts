/**
 * Shared fixtures.
 *
 * Everything here is fictional. Contract §4.2 forbids the runtime from naming a provider, voice,
 * or model, and §19.2 forbids Core's tests from requiring private knowledge — so `provider-a`,
 * `voice-a`, `example-show` are not placeholders awaiting real values, they are the only values
 * this package is ever allowed to contain.
 */

import type { ActorRef } from "@aldus-runtime/core";
import { SCHEMA_VERSION } from "@aldus-runtime/core";

import { digestText } from "../src/common.js";
import type { PerformanceScript } from "../src/performance.js";
import { planScopeDigest, type SynthesisParameters, type TtsRequestPlan } from "../src/request.js";
import type { TakeRecord } from "../src/take.js";
import type { AuthorizationOutcome, SpendAuthorizer } from "../src/ports.js";

export const RUN_ID = "run-a";
export const EPISODE_ID = "show:example-show:episode:episode-a";
export const SCRIPT_ID = "script-a";
export const PLAN_ID = "plan-a";
export const AT = "2026-01-01T00:00:00.000Z";

export const OPERATOR: ActorRef = { kind: "human", id: "operator-a" };
export const WORKER: ActorRef = { kind: "worker", id: "worker-a" };

export function parameters(overrides: Partial<SynthesisParameters> = {}): SynthesisParameters {
  return {
    provider: "provider-a",
    voice: "voice-a",
    model: "model-a",
    settings: { stability: 0.5 },
    seed: "seed-a",
    ...overrides,
  };
}

export function script(overrides: Partial<PerformanceScript> = {}): PerformanceScript {
  return {
    schemaVersion: SCHEMA_VERSION,
    scriptId: SCRIPT_ID,
    runId: RUN_ID,
    origin: "authored",
    segments: [
      { segmentId: "seg-1", spokenText: "The first thing to know is simple.", pace: "normal" },
      { segmentId: "seg-2", spokenText: "The second thing is less so." },
    ],
    createdAt: AT,
    ...overrides,
  };
}

export function plan(overrides: Partial<TtsRequestPlan> = {}): TtsRequestPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: PLAN_ID,
    runId: RUN_ID,
    scriptId: SCRIPT_ID,
    scriptSha256: digestText("script-a-contents"),
    parameters: parameters(),
    segments: [
      { segmentId: "seg-1", text: { raw: "The first thing to know is simple." } },
      { segmentId: "seg-2", text: { raw: "The second thing is less so." } },
    ],
    estimatedTotal: { amount: "0.0400", currency: "USD" },
    createdAt: AT,
    ...overrides,
  };
}

/** A take as a Worker would report it, paid and authorized against `forPlan`. */
export function paidTake(
  forPlan: TtsRequestPlan,
  overrides: Partial<TakeRecord> = {},
): Omit<TakeRecord, "schemaVersion" | "takeId" | "runId" | "planId" | "attempt" | "recordedAt"> {
  return {
    segmentId: "seg-1",
    text: {
      raw: "The first thing to know is simple.",
      finalProviderText: "The first thing to know is simple.",
    },
    parameters: parameters(),
    providerRequestId: "provider-request-a",
    costRecordId: "cost-a",
    authorization: {
      gateId: "performance-freeze",
      decisionId: "dec-a",
      grantId: "grant-a",
      planScopeSha256: planScopeDigest(forPlan),
    },
    audioSha256: digestText("audio-a"),
    ...overrides,
  } as Omit<TakeRecord, "schemaVersion" | "takeId" | "runId" | "planId" | "attempt" | "recordedAt">;
}

/** An authorizer that approves everything, standing in for a satisfied Performance Freeze. */
export class ApprovingAuthorizer implements SpendAuthorizer {
  constructor(
    private readonly decisionId = "dec-a",
    private readonly gateId = "performance-freeze",
  ) {}

  authorize(request: { planScopeSha256: string }): Promise<AuthorizationOutcome> {
    return Promise.resolve({
      authorized: true,
      gateId: this.gateId,
      decisionId: this.decisionId,
      grantId: "grant-a",
      planScopeSha256: request.planScopeSha256,
    });
  }
}

/** An authorizer that refuses, standing in for a stale or absent approval. */
export class RefusingAuthorizer implements SpendAuthorizer {
  constructor(private readonly explanation = 'Gate "performance-freeze" is stale.') {}

  authorize(): Promise<AuthorizationOutcome> {
    return Promise.resolve({ authorized: false, explanation: this.explanation });
  }
}
