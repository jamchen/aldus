/**
 * Shared test fixtures.
 *
 * The gate set below is contract §13's four gates written as an adopter would configure them.
 * They live in a test, not in `src/`, and that placement is the point: §4.2 keeps adopter process
 * out of the runtime, so the engine must be able to express §13 without knowing its names. If
 * these ever migrate into `src/`, the package has started owning adopter process.
 */

import type { ActorRef, CostRecord, Money } from "@aldus/core";
import { SCHEMA_VERSION } from "@aldus/core";

import { digestBytes, type GateSubject } from "../src/binding.js";
import type { GateDefinition } from "../src/definition.js";
import { SPEND_LIMIT_SUBJECT_KEY, grantLimitsDigest, type SpendGrant } from "../src/spend.js";

export const RUN_ID = "run-a";
export const EPISODE_ID = "show:example-show:episode:episode-a";
export const AT = "2026-01-01T00:00:00.000Z";

/** A human operator. */
export const OPERATOR: ActorRef = { kind: "human", id: "operator-a", displayName: "Operator A" };
/** A non-human actor, for the checks that must refuse one. */
export const AGENT: ActorRef = { kind: "agent", id: "agent-a", backendId: "backend-a" };

/** Gate ids, matching contract §13.1–§13.4. */
export const CONTENT_FREEZE = "content-freeze";
export const PERFORMANCE_FREEZE = "performance-freeze";
export const HUMAN_EAR = "human-ear";
export const RELEASE_UPLOAD = "release-upload";
export const RELEASE_PUBLISH = "release-publish";

/** Operations the release gates grant (contract §13.4). */
export const UPLOAD_OPERATION = "release.upload";
export const PUBLISH_OPERATION = "release.publish";

/**
 * Contract §13's gates as configuration.
 *
 * The dependency chain is §13's own narrative: content is frozen, then performance is authorized
 * against that content, then a human approves the result, then it is uploaded, and only then made
 * public. §13.4's "Uploading and making public SHOULD be separate operations" is why the last two
 * are two gates granting two operations rather than one gate granting both.
 */
export function standardGates(): GateDefinition[] {
  return [
    {
      gateId: CONTENT_FREEZE,
      title: "Content Freeze",
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["spokenText", "claims", "structure"],
      expiresOnChange: true,
    },
    {
      gateId: PERFORMANCE_FREEZE,
      title: "Performance Freeze and TTS Authorization",
      level: "human_oracle",
      enforcement: "blocking",
      // Contract §13.2's list, plus the spend ceiling the same section requires.
      binds: [
        "spokenText",
        "performanceScript",
        "voiceSettings",
        "requestPlan",
        SPEND_LIMIT_SUBJECT_KEY,
      ],
      dependsOn: [CONTENT_FREEZE],
      expiresOnChange: true,
    },
    {
      gateId: HUMAN_EAR,
      title: "Human Ear Gate",
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["approvedAudio"],
      dependsOn: [PERFORMANCE_FREEZE],
    },
    {
      gateId: RELEASE_UPLOAD,
      title: "Upload",
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["finalRender", "captions", "metadata", "destination"],
      dependsOn: [HUMAN_EAR],
      grants: [UPLOAD_OPERATION],
    },
    {
      gateId: RELEASE_PUBLISH,
      title: "Make public",
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["finalRender", "visibilityPolicy"],
      dependsOn: [RELEASE_UPLOAD],
      grants: [PUBLISH_OPERATION],
    },
  ];
}

/** Digest a label into a stable, well-formed subject hash. */
export function subject(key: string, value: string): GateSubject {
  return { key, sha256: digestBytes(value) };
}

/** Current subjects for every standard gate, all at their initial values. */
export function standardSubjects(
  overrides: Readonly<Record<string, string>> = {},
  grant?: SpendGrant,
): Record<string, GateSubject[]> {
  const value = (key: string): string => overrides[key] ?? `${key}-v1`;
  const spendSubject: GateSubject =
    grant === undefined
      ? subject(SPEND_LIMIT_SUBJECT_KEY, value(SPEND_LIMIT_SUBJECT_KEY))
      : { key: SPEND_LIMIT_SUBJECT_KEY, sha256: grantLimitsDigest(grant) };

  return {
    [CONTENT_FREEZE]: [
      subject("spokenText", value("spokenText")),
      subject("claims", value("claims")),
      subject("structure", value("structure")),
    ],
    [PERFORMANCE_FREEZE]: [
      subject("spokenText", value("spokenText")),
      subject("performanceScript", value("performanceScript")),
      subject("voiceSettings", value("voiceSettings")),
      subject("requestPlan", value("requestPlan")),
      spendSubject,
    ],
    [HUMAN_EAR]: [subject("approvedAudio", value("approvedAudio"))],
    [RELEASE_UPLOAD]: [
      subject("finalRender", value("finalRender")),
      subject("captions", value("captions")),
      subject("metadata", value("metadata")),
      subject("destination", value("destination")),
    ],
    [RELEASE_PUBLISH]: [
      subject("finalRender", value("finalRender")),
      subject("visibilityPolicy", value("visibilityPolicy")),
    ],
  };
}

/** A monetary amount in a fictional-but-valid currency code. */
export function money(amount: string, currency = "USD"): Money {
  return { amount, currency };
}

/** A spend grant tied to a decision. */
export function grantFor(decisionId: string, maxTotal: string, maxPerRequest?: string): SpendGrant {
  return {
    grantId: "grant-a",
    runId: RUN_ID,
    gateId: PERFORMANCE_FREEZE,
    decisionId,
    maxTotal: money(maxTotal),
    ...(maxPerRequest !== undefined ? { maxPerRequest: money(maxPerRequest) } : {}),
  };
}

/** A cost record drawn against an authorization. */
export function cost(
  costId: string,
  authorizationId: string,
  amounts: { actual?: string; estimated?: string },
  billingStatus: CostRecord["billingStatus"] = "charged",
): CostRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    costId,
    runId: RUN_ID,
    provider: "provider-a",
    operation: "synthesis",
    billingStatus,
    authorizationId,
    recordedAt: AT,
    ...(amounts.actual !== undefined ? { actual: money(amounts.actual) } : {}),
    ...(amounts.estimated !== undefined ? { estimated: money(amounts.estimated) } : {}),
  };
}
