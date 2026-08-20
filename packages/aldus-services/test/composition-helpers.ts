/**
 * Fixtures for the composed services: artifacts, release, and synthesis.
 *
 * Every identifier is fictional. Contract §4.2 keeps provider, platform, and adopter identities
 * out of the runtime including its test data, and §19.2 requires that no private knowledge be
 * needed to run Core's tests.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ActorRef, Money } from "@aldus-runtime/core";
import { SCHEMA_VERSION } from "@aldus-runtime/core";
import type { FileWorkspace } from "@aldus-runtime/file-store";
import {
  GateRegistry,
  digestSubjectValue,
  grantTermsDigest,
  type GateDefinition,
  type SpendGrant,
  type SubjectsByGate,
} from "@aldus-runtime/gate-engine";
import {
  RecordingReleaseAdapter,
  bestEffortOperation,
  requiredOperation,
  type RecordingAdapterOptions,
  type ReleaseBundle,
} from "@aldus-runtime/release";
import {
  planSubjectDigests,
  type PerformanceScript,
  type TtsRequestPlan,
} from "@aldus-runtime/tts-ledger";

import { AldusContext, AldusServices, isIssuedSynthesisPermit } from "../src/index.js";
import type {
  SynthesisAdapter,
  SynthesisAdapterCapabilities,
  SynthesisOutcome,
  SynthesisPermit,
  SynthesisRequest,
} from "../src/synthesis.js";
import { fixedClock, OPERATOR } from "./helpers.js";

export const RUN_ID = "run-a";
export const EPISODE_ID = "show:example-show:episode:episode-a";
export const DESTINATION_A = "destination-a";
export const SYNTHESIS_GATE = "performance-freeze";
export const UPLOAD_GATE = "release-upload";
export const PUBLISH_GATE = "release-publish";
export const UPLOAD_AUTHORITY = "release.upload";
export const PUBLISH_AUTHORITY = "release.publish";

/**
 * A synthesis adapter that records what it was asked to do.
 *
 * Counting calls is the point of every bypass test below: proving the adapter was *never reached*
 * is what "no money was spent" means, and a spy on the gateway could not establish it.
 */
export class RecordingSynthesisAdapter implements SynthesisAdapter {
  readonly id = "adapter-a";
  readonly calls: { request: SynthesisRequest; permitIssued: boolean }[] = [];
  #gatewayCheck: ((permit: SynthesisPermit) => boolean) | undefined;

  /** Let the adapter verify its permit, the way a real adapter should. */
  verifyWith(check: (permit: SynthesisPermit) => boolean): void {
    this.#gatewayCheck = check;
  }

  /**
   * What this adapter reports it actually did, where an adopter's adapter would differ.
   *
   * Unset by default, because an adapter that reports nothing is the ordinary case and the one
   * whose behaviour must not change (ADR-0038).
   */
  observation: Partial<SynthesisOutcome> = {};

  /** The cost record this double reports. Unset models a delivery that was never charged. */
  costRecordId: string | undefined = "cost-a";

  /** What this adapter declares before being called (#136). Unset means it declares nothing. */
  declares: SynthesisAdapterCapabilities | undefined;

  capabilities(): SynthesisAdapterCapabilities {
    return this.declares ?? {};
  }

  synthesise(request: SynthesisRequest, permit: SynthesisPermit): Promise<SynthesisOutcome> {
    this.calls.push({ request, permitIssued: this.#gatewayCheck?.(permit) ?? false });
    return Promise.resolve({
      providerRequestId: `request-${request.segmentId}`,
      audioSha256: "a".repeat(64),
      // A cost record is charge evidence and outranks anything the adapter says about itself, so a
      // double modelling a *free* delivery must not emit one. Leaving this on by default while
      // asserting `takePaidness` is "free" would have the assertion fail for the right reason and
      // the test read as though the implementation were wrong.
      ...(this.costRecordId === undefined ? {} : { costRecordId: this.costRecordId }),
      ...this.observation,
    });
  }
}

/** A PerformanceScript with one segment (contract §14.1). */
export function aScript(overrides: Partial<PerformanceScript> = {}): PerformanceScript {
  return {
    schemaVersion: SCHEMA_VERSION,
    scriptId: "script-a",
    runId: RUN_ID,
    origin: "authored",
    segments: [{ segmentId: "seg-1", spokenText: "The first line." }],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as PerformanceScript;
}

/** A request plan for one segment (contract §15, §13.2). */
export function aPlan(overrides: Partial<TtsRequestPlan> = {}): TtsRequestPlan {
  return {
    schemaVersion: SCHEMA_VERSION,
    planId: "plan-a",
    runId: RUN_ID,
    scriptId: "script-a",
    scriptSha256: "b".repeat(64),
    parameters: { provider: "provider-a", voice: "voice-a", model: "model-a" },
    segments: [
      {
        segmentId: "seg-1",
        text: { raw: "The first line." },
        // A plan is a cost preview (§19.3), so a segment carries what it is expected to cost.
        // Without it a reservation has no amount and the grant must permit unestimated dispatch.
        estimatedCost: { amount: "0.0100", currency: "USD" },
      },
    ],
    estimatedTotal: { amount: "0.0100", currency: "USD" },
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as TtsRequestPlan;
}

/** The subject key carrying the approved spend ceiling (ADR-0009). */
export const SPEND_LIMITS_KEY = "spend-limits";

/**
 * Subjects binding exactly what §13.2 requires for a plan, plus the approved ceiling.
 *
 * The plan digests come from `planSubjectDigests`, so an approval over these genuinely binds the
 * plan — which is what `gateEngineSpendAuthorizer` independently verifies. The ceiling is bound
 * separately because ADR-0009 puts the spend limits in `subjectHashes` as a digest, so raising a
 * limit drifts the approval rather than silently widening it.
 *
 * `grantTermsDigest` covers only the limits, never the grant's identity, which is why a template
 * grant can be digested before the decision it will cite even exists.
 */
export function subjectsForPlan(
  plan: TtsRequestPlan,
  gateId = SYNTHESIS_GATE,
  grant: SpendGrant = aGrant(),
): SubjectsByGate {
  return {
    [gateId]: [
      ...Object.entries(planSubjectDigests(plan)).map(([key, sha256]) => ({ key, sha256 })),
      // The digest of the grant actually in force. A test that varies the grant's terms and binds
      // the default one is approving something other than what it will use — and the approval
      // correctly refuses, which reads as a broken fixture rather than the binding working.
      { key: SPEND_LIMITS_KEY, sha256: grantTermsDigest(grant) },
    ],
  };
}

/**
 * Subjects whose plan digests are unrelated to the plan, but whose ceiling is correct.
 *
 * Isolates the check that matters: the gate is satisfied and the ceiling is genuinely approved, so
 * anything that refuses can only be the authorizer noticing the approval bound nothing about this
 * plan.
 */
export function subjectsBindingTheWrongPlan(plan: TtsRequestPlan): SubjectsByGate {
  return {
    [SYNTHESIS_GATE]: [
      ...Object.keys(planSubjectDigests(plan)).map((key) => ({
        key,
        sha256: digestSubjectValue(`unrelated-${key}`),
      })),
      { key: SPEND_LIMITS_KEY, sha256: grantTermsDigest(aGrant()) },
    ],
  };
}

/** A spend grant over a plan's gate (contract §13.2, §19.3). */
export function aGrant(overrides: Partial<SpendGrant> = {}): SpendGrant {
  return {
    grantId: "grant-a",
    runId: RUN_ID,
    gateId: SYNTHESIS_GATE,
    decisionId: "decision-a",
    scope: { operations: ["tts.synthesize"] },
    maxTotal: { amount: "10.00", currency: "USD" } satisfies Money,
    ...overrides,
  };
}

/** The synthesis gate, binding the plan digests plus the grant's ceiling (contract §13.2). */
export function synthesisGate(plan: TtsRequestPlan): GateDefinition {
  return {
    gateId: SYNTHESIS_GATE,
    level: "human_oracle",
    enforcement: "blocking",
    binds: [...Object.keys(planSubjectDigests(plan)), SPEND_LIMITS_KEY],
  };
}

/** Release gates keeping upload and publication separate (contract §13.4). */
export function releaseGates(): GateDefinition[] {
  return [
    {
      gateId: UPLOAD_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["render"],
      grants: [UPLOAD_AUTHORITY],
    },
    {
      gateId: PUBLISH_GATE,
      level: "human_oracle",
      enforcement: "blocking",
      binds: ["render"],
      grants: [PUBLISH_AUTHORITY],
    },
  ];
}

/** Subjects satisfying the release gates. */
export function releaseSubjects(value = "render-a"): SubjectsByGate {
  const subject = [{ key: "render", sha256: digestSubjectValue(value) }];
  return { [UPLOAD_GATE]: subject, [PUBLISH_GATE]: subject };
}

/** A bundle with one required upload and one best-effort notification (contract §17). */
export function aBundle(overrides: Partial<ReleaseBundle> = {}): ReleaseBundle {
  return {
    bundleId: "bundle-a",
    runId: RUN_ID,
    episodeId: EPISODE_ID,
    required: [
      requiredOperation({
        operationId: "upload",
        kind: "media-upload",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
        requiresAuthority: UPLOAD_AUTHORITY,
      }),
    ],
    bestEffort: [
      bestEffortOperation({
        operationId: "notify",
        kind: "notification",
        destination: DESTINATION_A,
        inputHashes: ["c".repeat(64)],
      }),
    ],
    ...overrides,
  };
}

/** Everything a composition test drives. */
export interface Harness {
  services: AldusServices;
  context: AldusContext;
  synthesis: RecordingSynthesisAdapter;
  release: RecordingReleaseAdapter;
  /**
   * The grant currently in force, mutable by the test.
   *
   * A grant names the `GateDecision` that authorized it, and a decision's id is minted when it is
   * recorded — so a fixture cannot know it in advance. Tests approve first, then set the grant to
   * cite the decision they just created, which is also the order a real operator works in.
   */
  grant: { current: SpendGrant | undefined };
}

/** Build services with the composed packages wired. */
export function makeComposedServices(
  workspace: FileWorkspace,
  options: {
    gates?: readonly GateDefinition[];
    subjects?: SubjectsByGate;
    /** Omit the grant provider entirely, so no spend authorizer exists at all. */
    withGrants?: boolean;
    withSynthesisAdapter?: boolean;
    withReleaseAdapter?: boolean;
    /** Scripted adapter outcomes per `operationId`; anything unlisted succeeds. */
    releaseOutcomes?: RecordingAdapterOptions["outcomes"];
    /** Pass `null` for a context with no default actor, to test §19.2's refusal. */
    actor?: ActorRef | null;
  } = {},
): Harness {
  const synthesis = new RecordingSynthesisAdapter();
  const release = new RecordingReleaseAdapter(DESTINATION_A, {
    ...(options.releaseOutcomes === undefined ? {} : { outcomes: options.releaseOutcomes }),
  });
  const actor = options.actor === null ? undefined : (options.actor ?? OPERATOR);
  const grant: { current: SpendGrant | undefined } = { current: undefined };

  const context = new AldusContext({
    workspace,
    gates: GateRegistry.from(options.gates ?? []),
    ...(actor === undefined ? {} : { actor }),
    subjects: () => Promise.resolve(options.subjects ?? {}),
    now: fixedClock(),
    ...(options.withSynthesisAdapter === false ? {} : { synthesisAdapter: synthesis }),
    ...(options.withReleaseAdapter === false ? {} : { releaseAdapters: [release] }),
    ...(options.withGrants === false ? {} : { spendGrants: () => grant.current }),
  });

  synthesis.verifyWith(isIssuedSynthesisPermit);

  return { services: new AldusServices(context), context, synthesis, release, grant };
}

/** Register a Run and its Episode so services have something to act on. */
export async function seedRun(services: AldusServices): Promise<void> {
  await services.init({ episode: { showId: "example-show", slug: "episode-a" }, actor: OPERATOR });
  await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    runId: RUN_ID,
    actor: OPERATOR,
  });
}

/** Write a file under the workspace and return its absolute path. */
export async function writeWorkingFile(
  root: string,
  relative: string,
  contents: string,
): Promise<string> {
  const path = join(root, relative);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, contents, "utf8");
  return path;
}

/** The digest a grant's ceiling must be bound by, for a gate that binds spend limits. */
export function grantSubject(grant: SpendGrant): { key: string; sha256: string } {
  return { key: "spend-limits", sha256: grantTermsDigest(grant) };
}
