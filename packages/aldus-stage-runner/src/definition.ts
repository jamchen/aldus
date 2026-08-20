/**
 * Stage definitions (architecture contract §11).
 *
 * §11 sketches `StageDefinition<I, O>` and then states seven obligations every stage MUST meet.
 * Three of them are enforced here in the type system rather than at runtime, because a rule the
 * compiler applies cannot be forgotten:
 *
 * - **"be idempotent or explicitly declare why it is not"** — {@link StageDefinition.idempotency}
 *   is required and its non-idempotent variant demands a reason. A stage cannot stay silent.
 * - **"validate its declared inputs"** and **"produce declared outputs or a structured failure"**
 *   — {@link StageDefinition.inputSchema} and `outputSchema` are required, and the runner applies
 *   both. A stage cannot opt out by leaving one undefined.
 *
 * The remaining obligations — recording configuration, safe retry, avoiding hidden mutation, and
 * stopping at gates — are the runner's to enforce, and are covered in `runner.ts`.
 */

import type {
  ArtifactRef,
  PromotionEvidence,
  QualityEnforcement,
  QualityLevel,
  Reconstructability,
  StructuredError,
} from "@aldus-runtime/core";

import { digestJson } from "./state.js";
import type { WorkerResult } from "./worker.js";

/**
 * The minimum a validator must offer for the runner to use it.
 *
 * Structurally satisfied by a Zod schema, so `z.object({…})` can be passed directly, but
 * deliberately *not* typed as one: contract §11 declares `inputSchema` and `outputSchema` as
 * `unknown`, and ADR-0002 makes Zod Core's choice rather than an obligation on adopters. A stage
 * authored against a different validator supplies an object of this shape instead.
 */
export interface StageSchema<T> {
  safeParse(value: unknown): StageSchemaResult<T>;
}

/** Outcome of a {@link StageSchema} check. */
export type StageSchemaResult<T> = { success: true; data: T } | { success: false; error?: unknown };

/**
 * One quality claim a Stage makes about a class of its findings (contract §12; #115).
 *
 * Per-channel rather than per-Stage, because a real evaluator is not one thing. The first adopter's
 * script checker emits errors that block and warnings that do not, from one deterministic
 * implementation — a single `level` and `enforcement` for the whole Stage would force them to
 * either promote the warnings or demote the errors, and both would be a lie about the check.
 */
export interface StageEvaluationChannel {
  /**
   * Which class of finding this claim covers, e.g. `"error"`, `"warning"`.
   *
   * An open string. Core names no severity scale — §4.2, and the same reason
   * `@aldus-runtime/regression` leaves `severityLevel` to the adopter: assuming `"critical"`
   * outranks `"major"` would be guessing at their vocabulary.
   */
  findingClass: string;
  /**
   * How this class of finding is judged (§12).
   *
   * `human_oracle` is deliberately unavailable to a Stage. A human-owned judgement is a Gate
   * Decision, not an automatic Stage execution — a Stage that appears to perform one is evidence
   * the judgement should be represented as a gate.
   */
  level: Exclude<QualityLevel, "human_oracle">;
  /** Whether findings of this class stop work or merely report (§12). */
  enforcement: QualityEnforcement;
  /**
   * Which form of evidence this channel emits (§12; #140).
   *
   * Declared rather than chosen per result, so it is reviewable before execution — the same
   * principle as {@link enforcement}. A stage that could decide per observation whether its output
   * is countable could make a defect rate mean whatever this run needed it to mean.
   *
   * The runner refuses an observation whose kind disagrees with this.
   */
  evidenceKind: "enumerated_findings" | "aggregate_reports";
  /** Calibration evidence, required when a model-assisted channel blocks (§12.1). */
  promotionEvidence?: PromotionEvidence;
}

/**
 * Resolve what an invocation owes, before it runs (ADR-0040).
 *
 * Returns `undefined` for a stage declaring `produces: "none"` — distinct from an empty array,
 * which is a `declared` stage whose resolver decided *this* invocation owes nothing. Both are
 * satisfied by registering nothing; they differ in what the record says, and §20 cares.
 */
export function resolveArtifactContract<I>(
  definition: Pick<StageDefinition<I, unknown>, "artifacts">,
  context: ArtifactContractContext<I>,
): readonly ArtifactObligation[] | undefined {
  const declaration = definition.artifacts;
  if (declaration.produces === "none") return undefined;
  return declaration.resolve(context);
}

/** What a resolved artifact contract found wrong with a set of registrations (ADR-0040). */
export interface ArtifactContractBreach {
  kind: string;
  reason: "missing" | "excess" | "undeclared";
  /** How many of this kind were registered. */
  registered: number;
  /** The bound that was not met. Absent for `undeclared`, which has no bound to state. */
  expected?: { minCount: number; maxCount?: number };
}

/**
 * Compare what a stage registered against what it owed (contract §8.1, §11; ADR-0040).
 *
 * All three breaches matter, and the third is the one an author would not think to ask for: a kind
 * registered that the contract does not declare is a stage doing something its declaration does
 * not describe. Letting it through would make the declaration advisory, and an advisory
 * declaration is worse than none because it reads as a check.
 *
 * Pure and derived on read. Nothing stores a breach — the attempt stores the expectation and the
 * registrations, and this recomputes, so the two can never disagree.
 */
export function checkArtifactContract(
  expected: readonly ArtifactObligation[] | undefined,
  registered: readonly ArtifactRef[],
): readonly ArtifactContractBreach[] {
  const breaches: ArtifactContractBreach[] = [];
  const counts = new Map<string, number>();
  for (const artifact of registered) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  }

  // A stage declaring `produces: "none"` owes nothing and may register nothing. Anything it did
  // register is undeclared by definition.
  const obligations = expected ?? [];
  for (const obligation of obligations) {
    const found = counts.get(obligation.kind) ?? 0;
    if (found < obligation.minCount) {
      breaches.push({
        kind: obligation.kind,
        reason: "missing",
        registered: found,
        expected: {
          minCount: obligation.minCount,
          ...(obligation.maxCount === undefined ? {} : { maxCount: obligation.maxCount }),
        },
      });
    } else if (obligation.maxCount !== undefined && found > obligation.maxCount) {
      breaches.push({
        kind: obligation.kind,
        reason: "excess",
        registered: found,
        expected: { minCount: obligation.minCount, maxCount: obligation.maxCount },
      });
    }
  }

  const declared = new Set(obligations.map((obligation) => obligation.kind));
  for (const [kind, found] of counts) {
    if (!declared.has(kind)) {
      breaches.push({ kind, reason: "undeclared", registered: found });
    }
  }
  return breaches;
}

/**
 * One kind of artifact a stage owes the registry, and how many (contract §8.1, §11; ADR-0040).
 *
 * `kind` is an adopter-defined opaque string (§4.2). Aldus checks that *something claiming that
 * kind* was registered; it cannot check that `"video"` is a video, and does not pretend to.
 */
export interface ArtifactObligation {
  /** Adopter-defined artifact kind. Opaque to Core. */
  kind: string;
  /** Fewest registrations of this kind that satisfy the contract. `0` makes the kind permitted. */
  minCount: number;
  /** Most registrations permitted. Absent means unbounded. */
  maxCount?: number;
}

/**
 * What the resolver may see when deciding what a stage owes (ADR-0040).
 *
 * Exactly the validated invocation, and nothing else. The stage's return value and the artifacts
 * it registered are **deliberately absent**: an obligation derived from what a stage produced is
 * satisfied by construction, and the defect this exists to catch would define away its own
 * postcondition — a stage that registered nothing would be found to have owed nothing.
 *
 * There is no filesystem or I/O access either. A mode that cannot be derived from these three is a
 * hidden input and has to be made explicit before it can decide an obligation; letting the resolver
 * read the world would make a contract depend on state nothing recorded, which is ADR-0036's defect
 * in a new place.
 */
export interface ArtifactContractContext<I = unknown> {
  /** The stage's input, after `inputSchema` validated it. */
  readonly input: I;
  /** The configuration recorded on this attempt (§11, §20). */
  readonly configuration: Record<string, unknown>;
  /** Artifacts declared as inputs to this invocation (§11). */
  readonly inputArtifacts: readonly ArtifactRef[];
}

/**
 * What a stage owes the registry (contract §8.1, §11; ADR-0040, #138).
 *
 * **Required on every stage, and `"none"` is written down.** An optional field left off by an
 * author who forgot is indistinguishable from one left off by an author who meant it — and the
 * whole defect being fixed is that an absence was unreadable. A stage that registered nothing
 * settled `succeeded` with an empty artifact list, identical to a stage that correctly produced
 * none, and an adopter's 34 MB video went unregistered on every render for months because a typo
 * and a skipped output were the same observation.
 *
 * Making this required turns each existing stage into a decision someone made once, at a compiler
 * error, which is the only moment the question is cheap.
 */
export type StageArtifactDeclaration<I = unknown> =
  | {
      /** This stage registers no artifacts. Stated, not inferred from an empty list. */
      produces: "none";
    }
  | {
      produces: "declared";
      /**
       * What this invocation owes, decided before the stage runs.
       *
       * Called once, after `inputSchema` validates and before `execute`. Returning an empty list
       * is legal and means *this* invocation owes nothing — distinct from `"none"`, which says the
       * stage never registers anything.
       */
      resolve(context: ArtifactContractContext<I>): readonly ArtifactObligation[];
    };

/**
 * A Stage's declaration that it executes an evaluator (contract §12; #115).
 *
 * Optional, and an ordinary Stage stays ordinary. What this prevents is an evaluator Stage
 * becoming blocking through an unreviewed boolean or a convention: §12's model lived only in
 * `gate-engine`, so a Stage running a linter could declare nothing at all, and §12.1 was
 * enforceable at one of the two places it applies.
 *
 * Declaring this does **not** hand Aldus the adopter's editorial policy. Aldus defines the
 * available claims and the evidence each requires, and refuses internally inconsistent ones. Which
 * declared violations stop a pipeline remains the adopter's, and a deterministic rule is not
 * reclassified as model-assisted merely because its subject is prose.
 */
export interface StageEvaluationDeclaration {
  /** One claim per class of finding the Stage emits. At least one. */
  channels: readonly StageEvaluationChannel[];
  /**
   * Defect classes this evaluator structurally cannot see (§12.1, §9.3).
   *
   * A hard gate may reliably block what it detects without claiming to detect everything, and the
   * limit is recorded rather than implied — an adopter measured recall of 0.5 on a checker whose
   * miss was a section its parser cuts before checking. Reported so a green result is never read
   * as semantic correctness (§12).
   */
  scopeLimitations?: readonly string[];
}

/**
 * What a stage asks of {@link StageContext.runWorker} (ADR-0035).
 *
 * Deliberately small: which Worker, what it needs, and what it is being given. Everything else —
 * run, episode, stage, attempt, digests, keys, signal — is supplied by the runtime from the
 * attempt in progress, because a Worker that could state its own identity could state a false one.
 */
export interface StageWorkerRequest<I = unknown> {
  /** Worker id, resolved exactly. */
  workerId: string;
  /** Worker version, resolved exactly — never "latest" (§20). */
  workerVersion: string;
  /** The operation's input. Validated by the stage; Core does not know its shape. */
  input: I;
  /**
   * Capabilities this operation requires of the Worker.
   *
   * Checked before `execute`. Omitted means the stage requires none, which is different from a
   * Worker offering none — the check fails closed on what was asked for, not on what was offered.
   */
  requiredCapabilities?: readonly string[];
  /**
   * Whether **this invocation** performs an external effect, and what deduplicates it (#148).
   *
   * Required, and `{ kind: "none" }` is the explicit answer. A Worker invocation is one
   * deduplication unit: an effect key belongs to the independently deduplicated effect, never
   * automatically to the attempt containing it. Previously every invocation in an attempt received
   * one attempt-level key, so a stage performing N writes handed the receiving platform N requests
   * carrying the same value — and a platform deduplicating on it drops writes 2..N as repeats of
   * the first. Every call returns successfully and N-1 of them did nothing.
   *
   * If one invocation internally performs N independently deduplicated writes, it must expose them
   * as N invocations with N keys, or own a real batch protocol whose key identifies the exact batch
   * effect. One key for N unrelated destination objects is the defect, not a shortcut.
   */
  effect: WorkerEffect;
}

/**
 * What one Worker invocation does outside the workspace (§19.1; #148).
 *
 * Two arms, and the effectful one carries its key rather than inheriting one. A key that arrives
 * by inheritance describes the thing that passed it down, not the effect it is deduplicating.
 */
export type WorkerEffect =
  | {
      /** This invocation touches nothing outside the workspace. */
      kind: "none";
    }
  | {
      /** The receiving system deduplicates this effect on the key below. */
      kind: "deduplicated";
      /**
       * What the destination deduplicates on, for **this** effect.
       *
       * Must identify the effect's content, not its container. ADR-0033 established by measurement
       * that a reassembled bundle with a fresh id re-published everything; a digest over the
       * collection an effect happens to belong to has the same defect, because enclosure and
       * content move independently.
       */
      idempotencyKey: string;
    };

/**
 * Fingerprint the declared work of one stage invocation (contract §20; ADR-0036).
 *
 * Material is episode, stage identity and version, the validated input, the recorded
 * configuration, and the sorted identities and digests of declared input artifacts. Sorted because
 * the *set* of declared inputs is what identifies the work, not the order a caller listed them in
 * — the same reason ADR-0033 sorts release input hashes.
 *
 * `runId` is deliberately absent: two Runs performing the same declared work produce the same
 * fingerprint, which is what makes it one. Including it would reintroduce ADR-0033's defect one
 * layer up, where a reassembled identity produced a fresh key and re-performed settled work.
 *
 * **Never offer this to an external system as a deduplication guarantee.** It covers what the
 * stage declared, and a stage that reads by convention declares less than it reads.
 */
export function deriveInvocationKey(material: {
  episodeId: string;
  stageId: string;
  stageVersion: string;
  input: unknown;
  configuration: Readonly<Record<string, unknown>>;
  inputArtifacts: readonly { artifactId: string; sha256: string }[];
}): string {
  return digestJson({
    episodeId: material.episodeId,
    stageId: material.stageId,
    stageVersion: material.stageVersion,
    input: material.input,
    configuration: material.configuration,
    inputArtifacts: [...material.inputArtifacts]
      .map((artifact) => `${artifact.artifactId}:${artifact.sha256}`)
      .sort(),
  });
}

/**
 * What a stage's effect-key derivation is given (contract §19.1; ADR-0036).
 *
 * A context rather than a bare input. The previous hook received only `input`, which could not
 * reach the class of stage that most needed it: a stage resolving its work from the Run declares
 * `inputSchema: z.object({})`, so its author could not write a key function that distinguished
 * anything however willing.
 */
export interface EffectKeyContext {
  /** Canonical Episode identity (§6.1). */
  episodeId: string;
  /** Stage declaring the effect (§11). */
  stageId: string;
  /** Version of the stage definition (§11, §20). */
  stageVersion: string;
  /** The validated input. */
  input: unknown;
  /** The configuration this attempt runs under, as supplied. */
  configuration: Readonly<Record<string, unknown>>;
  /**
   * Identities and digests of the artifacts the stage declared as inputs (§8.1).
   *
   * The content identity available to the derivation. ADR-0033 established by measurement that a
   * key must depend on what is being sent rather than on the identity of whatever is enclosing
   * it — a reassembled bundle with a fresh id re-published everything.
   */
  inputArtifacts: readonly { artifactId: string; sha256: string }[];
}

/**
 * What re-running a stage does to the world outside the workspace (§11, §15.1, §19.1; ADR-0036).
 *
 * Three states, where there were previously two words for three meanings. An adopter reported nine
 * of thirteen stages declaring `not_idempotent`, several because the stage's *output* is not
 * reproducible rather than because re-running has an external effect — §15.1's retry refusal is
 * right for the second and merely conservative for the first.
 */
export type StageRetrySafety =
  | {
      /**
       * Re-running touches nothing outside the workspace.
       *
       * Named for what it claims. It was `idempotent`, which reads as a property of the
       * computation and was taken as one: a stage uploading to a cloud drive declared it, because
       * the author was reasoning about the invocation key's precision and never re-read what the
       * arm asserts. The claim is about the **world**, and nothing can check it — which is why the
       * name has to carry the whole meaning.
       */
      kind: "no_external_effects";
    }
  | {
      /**
       * One independently deduplicated external effect, keyed at the stage.
       *
       * Valid **only** when the stage performs exactly one such effect. A stage-level key has one
       * cardinality and N effects have another, and propagating one key across several effects is
       * how N writes become one (#149).
       */
      kind: "deduplicated_external_effects";
      keyScope: "stage";
      /**
       * Derive the key the external system deduplicates on.
       *
       * Must depend on effect identity and content digests (ADR-0033). `runId`, attempt id, path
       * and bundle identity are not substitutes, which ADR-0033 established by measurement rather
       * than argument — and neither is a digest over the collection an effect belongs to.
       */
      effectKey: (context: EffectKeyContext) => string;
    }
  | {
      /**
       * Every external effect crosses the Worker seam, and each invocation supplies its own key.
       *
       * The arm for a stage whose effects are N and individually deduplicated — a content-addressed
       * archive uploading each artifact under its own digest. Nothing here is a stage-wide key,
       * because there is no stage-wide effect to key.
       *
       * **This is not a trust arm.** It does not say "the adapter promises this is safe"; it says
       * every effect is declared and keyed at the seam where it happens. The runtime cannot prove
       * a destination honours a key, just as it cannot prove a stage has no hidden effects — what
       * it enforces is that the claim is explicit, correctly scoped, supplied at the execution
       * seam, recorded, and read by retry policy.
       */
      kind: "deduplicated_external_effects";
      keyScope: "worker_invocation";
      /** Why per-invocation deduplication is sound here. Read at retry-decision time, not filed. */
      reason: string;
    }
  | {
      /**
       * Re-running duplicates an effect that cannot be deduplicated.
       *
       * Never auto-retried: §15.1's "Aldus MUST NOT silently retry paid requests without policy
       * and cost authorization". An operator can still re-run explicitly, having read the reason.
       *
       * Individual Worker calls may still carry keys. That does not make the stage retry-safe —
       * the arm is about the stage, and a keyed call inside an unkeyed whole is still an unkeyed
       * whole.
       */
      kind: "not_idempotent";
      /** Why re-running duplicates an effect. Recorded on every attempt and surfaced to operators. */
      reason: string;
    };

/** Retry backoff shape (contract §19.1 "retry classification and limits"). */
export interface RetryBackoff {
  /** Delay before the second attempt. */
  initialMs: number;
  /** Multiplier applied to each subsequent delay. */
  factor: number;
  /** Ceiling on any single delay. */
  maxMs: number;
}

/** How many times, and how fast, a stage may be retried (contract §19.1). */
export interface RetryPolicy {
  /**
   * Total attempts including the first. `1` disables retry.
   *
   * Counted rather than expressed as "retries" because §6.3's `attempt` ordinal is 1-based and
   * two different meanings of the same number is how off-by-one budgets happen.
   */
  maxAttempts: number;
  /** Delay schedule. Absent means retry immediately. */
  backoff?: RetryBackoff;
}

/** Spend limits for a stage that can incur cost (contract §19.3). */
export interface CostPolicy {
  /**
   * Whether the stage can preview its cost without incurring it (contract §19.3 "dry-run or cost
   * preview where possible").
   */
  supportsPreview: boolean;
  /**
   * Whether execution requires a recorded spend authorization (contract §13.2, §19.3).
   *
   * The runner records the requirement and refuses to auto-retry; *evaluating* the authorization
   * is WP-05's. A stage that sets this and is run without a decision is a WP-05 concern, not a
   * silent pass here.
   */
  requiresAuthorization: boolean;
}

/** What a stage may hand back to the runner. */
/**
 * One thing an evaluator found (contract §12, §12.3; #115).
 *
 * **An enumerated defect occurrence**, and countable as exactly one. That is what this type has
 * always meant, which is why a record carrying it decodes as {@link EnumeratedFinding} without
 * needing a discriminant (#140).
 */
export interface EvaluationFinding {
  /**
   * Which declared channel this finding belongs to, e.g. `"error"`, `"warning"`.
   *
   * Matched against {@link StageEvaluationChannel.findingClass}. A finding whose class the stage
   * never declared is refused rather than guessed at: its enforcement would otherwise be decided
   * by a default nobody wrote down.
   */
  findingClass: string;
  /** What was found. Operator-facing, and redacted before it reaches a record (§19.2). */
  message: string;
  /** Adopter-defined category, e.g. `"claim/unsupported"`. Open string — Core names none (§4.2). */
  category?: string;
  /** Where, in whatever terms the adopter's subject has. */
  locator?: string;
}

/** One identified defect occurrence. Counts as one finding (§12; #140). */
export interface EnumeratedFinding extends EvaluationFinding {
  kind: "finding";
}

/**
 * An evaluator reported something without enumerating what (§12; #140).
 *
 * Deliberately carries no `locator` and no `category`. It is not a defect that happens to lack
 * detail — it is the statement *"this evaluator had something to say"*, and giving it the fields
 * of a finding would invite it to be counted as one.
 *
 * The case is a wrapped legacy evaluator. An adopter's three vendored linters return a process
 * result — exit code, stdout, stderr — and no findings, so the finest true thing their stage can
 * say is that a linter reported. Parsing that output into per-finding shape was considered and
 * rejected by them: §3.7 says wrap before rewriting, and a parser over another program's
 * human-facing output is a second implementation of its semantics, with nothing keeping the two in
 * step and a silent failure mode the day a message changes.
 */
export interface AggregateReport {
  kind: "report";
  /** Which declared channel this report belongs to. */
  findingClass: string;
  /** What the evaluator said. Operator-facing, redacted before it reaches a record (§19.2). */
  message: string;
}

/**
 * What an evaluator emitted about one subject (contract §12; #140).
 *
 * Two closed semantics, discriminated, because the difference is **countability** rather than
 * scope. A document-wide omission may still be one enumerated defect, and a report about one file
 * may contain an unknown number of them: subject scope and statistical cardinality are orthogonal,
 * and modelling the first would leave the second unmeasurable while looking solved.
 *
 * The rule that follows and matters most: **a report must never silently contribute 1 to a defect
 * count**, and the absence of parsed findings inside a report is not zero defects. See
 * {@link countEvaluationEvidence}.
 */
export type EvaluationObservation = EnumeratedFinding | AggregateReport;

/**
 * Read a record that predates the discriminant (#140).
 *
 * `EvaluationFinding` documented itself as one identified defect, so that is what it decodes to.
 * The compatibility runs one way only: nothing infers a report from an undiscriminated record,
 * because a record written under the old meaning was never claiming to be one.
 */
export function asEnumeratedFinding(finding: EvaluationFinding): EnumeratedFinding {
  return { ...finding, kind: "finding" };
}

/** How much an evaluator's evidence establishes (contract §12; #140). */
export interface EvaluationEvidenceCount {
  /** Defect occurrences actually enumerated. Safe to use as a defect count. */
  enumeratedFindings: number;
  /** Evaluator reports. **Not** defects, and never summed into a defect count. */
  reports: number;
  /**
   * Whether a defect count over this evidence is measurable at all.
   *
   * `false` when any report is present. A report establishes that an evaluator had something to
   * say and nothing about how much — so the honest defect count is *unknown*, which is neither
   * zero nor the number of reports. A consumer computing a defect rate must treat this as
   * unmeasurable rather than substituting either.
   */
  defectCountMeasurable: boolean;
}

/**
 * Separate what was counted from what was merely reported (contract §12; #140).
 *
 * The whole reason the discriminant exists. Summing observations would count one vendored linter's
 * report as one defect when it might stand for forty, and a defect rate computed that way is wrong
 * in a direction nobody checks — it looks plausible.
 */
export function countEvaluationEvidence(
  observations: readonly EvaluationObservation[],
): EvaluationEvidenceCount {
  const enumeratedFindings = observations.filter((entry) => entry.kind === "finding").length;
  const reports = observations.length - enumeratedFindings;
  return { enumeratedFindings, reports, defectCountMeasurable: reports === 0 };
}

export type StageOutcome<O> =
  | { kind: "completed"; output: O }
  | {
      /**
       * The evaluator ran and reported (contract §12; #115).
       *
       * **Not a failure.** An evaluator that could not execute, parse its inputs or produce a
       * valid report fails the stage in the ordinary way, by throwing; this is the outcome where
       * it worked and has something to say. Conflating the two is how a crashed checker gets
       * counted as a clean one.
       *
       * Whether any of it stops work is decided by the stage's declared channels, not here: a
       * stage does not get to promote its own findings past the enforcement it declared, which is
       * the whole point of declaring them (§12.1).
       */
      kind: "evaluated";
      output: O;
      /**
       * What the evaluator emitted, each discriminated as an enumerated finding or a report.
       *
       * Replaces the previous `findings` list. Stored records written under the old shape decode
       * as enumerated findings via {@link asEnumeratedFinding}; a live outcome states which it is,
       * because a value being constructed right now has no excuse not to.
       */
      observations: readonly EvaluationObservation[];
    }
  | {
      kind: "gate_required";
      /** Gate that must be decided before this stage can continue (contract §13). */
      gateId: string;
      /**
       * Hashes the eventual decision binds to (contract §13 `subjectHashes`).
       *
       * Recorded now so that WP-05 can bind an approval to exactly what the stage saw, and so
       * that a later change to those inputs invalidates the approval (§13.1, §13.2).
       */
      subjectHashes?: string[];
      /** Operator-facing explanation of what is being decided. */
      reason?: string;
    };

/**
 * Provenance only the stage knows (contract §8.1, §20).
 *
 * Deliberately narrow. The fields §8.1 names — which stage, run, code revision, and
 * configuration produced an artifact — are **not** here, because the runner supplies them from
 * the attempt. A stage cannot state them, so it cannot state them wrongly: an artifact whose
 * provenance disagrees with the attempt that produced it is unrepresentable rather than merely
 * discouraged.
 */
export interface StageProvenanceExtras {
  /**
   * Provider seed, where one was used (contract §8.1, §14.4).
   *
   * Recorded for trace only. §8.1 states a seed "MUST NOT be treated as a reproducibility
   * guarantee", and nothing re-derives an artifact from one.
   */
  providerSeed?: string;
  /** Knowledge Packs in force when the artifact was produced (contract §20). */
  knowledgePackIds?: readonly string[];
  /** Free-text note from the producer. Already redacted (§19.2). */
  note?: string;
}

/**
 * What a stage states about an output it wants registered (contract §8, §8.1).
 *
 * Everything here is something only the stage knows. Notice what is absent: `producerRunId`,
 * `producerStageId`, `codeRevision`, `configHash`, and `sha256`. The first four come from the
 * attempt, and the digest is computed from the bytes — §8.1 makes the digest half of an
 * artifact's identity, and §13 binds approvals to it, so a caller-supplied digest could bind an
 * approval to bytes nobody checked.
 */
export interface StageOutputRegistration {
  /** Path to the produced bytes. Hashed and sized by the registry. */
  path: string;
  /** What kind of artifact this is (contract §8.2). Open string; Core names no taxonomy (§4.2). */
  kind: string;
  /** IANA media type of the bytes. */
  mediaType: string;
  /**
   * How recoverable it is (contract §8).
   *
   * The one field a stage must get right and nothing else can supply: §8.1 makes
   * `irreplaceable` what stops a cleanup removing bytes a human already accepted and paid for.
   */
  reconstructability: Reconstructability;
  /** Digests of the inputs it was derived from (contract §8.1). Defaults to none. */
  inputHashes?: readonly string[];
  /** Provenance the attempt cannot know. @see StageProvenanceExtras */
  provenance?: StageProvenanceExtras;
  /** Artifact ID to use. Defaults to a freshly minted one. */
  artifactId?: string;
  /** URI recorded as the artifact's location. Defaults to a `file:` URI for `path`. */
  uri?: string;
}

/**
 * A registration with the attempt's own facts filled in (contract §8.1).
 *
 * Built by the runner, never by a stage. This is the shape an {@link ArtifactRecorder} receives.
 */
export interface ArtifactRecorderRequest extends StageOutputRegistration {
  /** Run that produced it — from the attempt, not the stage. */
  producerRunId: string;
  /** Stage that produced it — from the attempt, not the stage. */
  producerStageId: string;
  /** Revision of the runtime code, from the Run manifest. Absent when the Run records none. */
  codeRevision?: string;
  /** Digest of the exact configuration this attempt ran under (contract §11, §20). */
  configHash: string;
  /** The attempt's configuration, already redacted (contract §19.2). */
  configuration?: Record<string, unknown>;
}

/**
 * Somewhere to register a produced artifact (contract §8, ADR-0027).
 *
 * A **port**, not a dependency. `@aldus-runtime/artifact-registry` satisfies it structurally, and
 * this package deliberately does not import it: a runner depending on the registry would invert
 * the layering, and §7 requires core models to stay independent of physical storage. Whoever
 * composes the two wires them together (ADR-0015).
 */
export interface ArtifactRecorder {
  /** Hash the bytes, record the artifact, and return the reference. */
  register(request: ArtifactRecorderRequest): Promise<ArtifactRef>;
}

/**
 * What a stage is given when it runs.
 *
 * Everything the stage may legitimately touch arrives through here. §11 requires a stage to
 * "avoid hidden mutation outside declared outputs", and a context that carries its own output
 * channel is what makes the declared path the convenient one.
 */
export interface StageContext {
  /** Run this attempt belongs to (contract §6.2). */
  readonly runId: string;
  /** Canonical Episode identity (contract §6.1). */
  readonly episodeId: string;
  /** Stage being executed. */
  readonly stageId: string;
  /** Version of the stage definition in force. */
  readonly stageVersion: string;
  /** Identity of this attempt (contract §6.3). */
  readonly attemptId: string;
  /** 1-based ordinal of this attempt within the stage execution (contract §6.3). */
  readonly attempt: number;
  /** Who or what is performing this attempt (contract §19.2). */
  readonly actor: import("@aldus-runtime/core").ActorRef;
  /**
   * The exact configuration this attempt runs under (contract §11, §20).
   *
   * Recorded verbatim, and redacted before it reaches any durable record (§19.2).
   */
  readonly configuration: Readonly<Record<string, unknown>>;
  /** Digest of {@link configuration}, so §20 can answer "which configuration produced this". */
  readonly configurationHash: string;
  /**
   * Fingerprint of this attempt's declared work (§20; ADR-0036).
   *
   * For the trace and for correlating retries. Never an external deduplication guarantee.
   */
  readonly invocationKey: string;
  /**
   * The key an external system deduplicates this stage's effect on (§19.1; ADR-0036).
   *
   * Present only when the stage declared `idempotent_external_effect`. **Absent is not a licence
   * to use {@link StageContext.invocationKey} instead** — that key fingerprints declared work and
   * is stable across content a stage read but did not declare. A stage performing an external
   * effect without declaring one is refused before it runs.
   */
  readonly effectKey?: string | undefined;
  /** Artifacts declared as inputs (contract §11). */
  readonly inputArtifacts: readonly ArtifactRef[];
  /**
   * Cancellation signal (contract §19.1).
   *
   * A long-running stage SHOULD check this. The runner also checks it around execution, so a
   * stage that ignores it is still cancellable — just not promptly.
   */
  readonly signal: AbortSignal;
  /**
   * Record an output artifact as soon as it exists.
   *
   * Called during execution rather than returned at the end, so that §19.1's "recovery from
   * partial success" is real: a stage that produced two artifacts and then failed leaves both
   * recorded and attributable, instead of losing them with the return value.
   */
  recordOutput(artifact: ArtifactRef): void;
  /**
   * Register a produced file and record it as an output, in one call.
   *
   * The preferred path. {@link StageContext.recordOutput} requires a stage to have obtained an
   * `ArtifactRef` from somewhere, which in practice means closing over a registry the stage
   * cannot reach until the context exists — a loop every adopter has had to break for itself.
   *
   * The provenance §8.1 demands is supplied from the attempt rather than by the stage: the run,
   * the stage, the code revision, and the configuration digest are all facts the runner already
   * holds. A stage states only what it knows, so the mismatch §8.1 exists to prevent is
   * unrepresentable rather than merely unlikely.
   *
   * The returned artifact is also recorded, so a stage never calls both for one file.
   *
   * @throws {AldusError} `ALDUS_ARTIFACT_RECORDER_UNAVAILABLE` when no recorder is wired. A
   * refusal rather than a silent no-op: a stage that believed it registered an irreplaceable
   * take and did not would discover it the day a cleanup removed the bytes.
   */
  registerOutput(registration: StageOutputRegistration): Promise<ArtifactRef>;
  /**
   * Invoke a registered Worker (contract §3.2, §4.1; ADR-0035).
   *
   * Resolved by **exact** id and version — nothing selects a nearest or latest one, so a completed
   * Run stays explicable after a second version is registered (§20).
   *
   * The runtime supplies the invocation's identity from this attempt: run, episode, stage,
   * attempt, configuration digest, declared input digests, effect or invocation key, and the
   * cancellation signal. A Worker therefore cannot assert its own provenance, which is what keeps
   * §20's trace attributable to what executed rather than to what a Worker claimed.
   *
   * Capabilities are checked **before** `execute`, so a misconfiguration fails on the declaration
   * rather than halfway through a side effect. A composition that wired no registry refuses rather
   * than silently doing nothing — the capability that exists and is unreachable is #67's defect,
   * and a Worker seam nothing wired would repeat it one layer up.
   *
   * @throws {AldusError} `ALDUS_WORKER_REGISTRY_UNAVAILABLE`, `ALDUS_WORKER_NOT_REGISTERED`,
   * `ALDUS_WORKER_CAPABILITY_UNAVAILABLE`
   */
  runWorker<I, O>(request: StageWorkerRequest<I>): Promise<WorkerResult<O>>;
  /** Emit an operator-facing progress note. Recorded on the attempt's events (contract §20). */
  note(message: string, details?: Record<string, unknown>): void;
}

/**
 * A versioned unit of work within a workflow (architecture contract §11).
 *
 * §3.7 and §11 both allow a stage to be coarse: a large existing script wrapped whole is a valid
 * stage, and boundaries "SHOULD become finer only when partial retry, observability, reuse, or
 * quality control justifies it". Nothing here requires decomposition.
 */
export interface StageDefinition<I = unknown, O = unknown> {
  /** Stable identity of the stage. An open string — workflows belong to adopters (§4.2). */
  id: string;
  /** Version of this definition. Recorded on every attempt so §20 can answer what ran. */
  version: string;
  /** Validator for the stage's input (contract §11 "validate its declared inputs"). */
  inputSchema: StageSchema<I>;
  /** Validator for the stage's output (contract §11 "produce declared outputs"). */
  outputSchema: StageSchema<O>;
  /**
   * Capabilities the executing backend must declare (contract §10).
   *
   * Open strings: §10 lists the *kinds* of capability a backend should declare, and §4.2 keeps
   * Core from enumerating backends. Checked before execution.
   */
  requiredCapabilities: readonly string[];
  /**
   * This stage's quality claims, when it executes an evaluator (§12; #115).
   *
   * Absent for an ordinary stage, which is most of them. Present means the stage emits findings
   * whose enforcement Aldus refuses to accept if the claim is internally inconsistent.
   */
  evaluation?: StageEvaluationDeclaration;
  /**
   * What this stage owes the artifact registry (§8.1, §11; ADR-0040).
   *
   * Required, and `{ produces: "none" }` is the explicit answer for a value-only stage. §11 permits
   * no silent answer here for the same reason it permits none for {@link retrySafety}.
   */
  artifacts: StageArtifactDeclaration<I>;
  /**
   * What re-running this stage does outside the workspace (§19.1; #148).
   *
   * Required — §11 permits no silent answer. Named `retrySafety` rather than `idempotency` because
   * the arms make claims about the world rather than about the computation, and the old name
   * invited reading `idempotent` as "the function is pure".
   */
  retrySafety: StageRetrySafety;
  /**
   * Gates that must be satisfied before this stage should be offered (contract §11 "stop at
   * required gates", §13).
   *
   * **Declarative here; enforced one layer up.** The runner cannot evaluate a gate — gate state
   * belongs to `@aldus-runtime/gate-engine`, which this package deliberately does not depend on —
   * so this field does not stop `run()` *within this package*. It tells the next-action policy
   * which gates actually gate this stage, so an unrelated pending gate no longer suppresses
   * unrelated work (ADR-0021).
   *
   * `@aldus-runtime/services` **does** refuse a stage whose declared gate is unsatisfied
   * (ADR-0024), because it holds both the gate engine and the subjects provider and so is the
   * layer where §11's "stop at required gates" can actually be honoured. Read in isolation this
   * field looks advisory; through the services it is not.
   *
   * **Do not gate a stage on a gate that binds that stage's own output.** The gate cannot be
   * decided until the artifact exists, the artifact does not exist until the stage runs, and the
   * stage will not run until the gate is decided — a deadlock with no action that clears it. It
   * is not detectable here: what a gate binds is adopter process supplied through a
   * `SubjectsProvider` (§4.2), so nothing relates a subject to the stage that produces it. A gate
   * approving a stage's output belongs on the stage that **consumes** that output. The first
   * adopter had three of these, harmless until gate enforcement landed and made them fatal.
   *
   * Absent means "not declared", which is not the same as "requires nothing": see ADR-0021 for
   * why an undeclared stage falls back to the conservative reading rather than being treated as
   * unblocked. Declare `[]` to say a stage genuinely requires no gate.
   *
   * A workflow graph supplied to the services overrides this per workflow, because one stage
   * definition may be reused by workflows that gate it differently.
   */
  requiredGates?: readonly string[];
  /** Spend limits, for a stage that can incur cost (contract §19.3). */
  costPolicy?: CostPolicy;
  /** Retry limits (contract §19.1). Absent means a single attempt. */
  retryPolicy?: RetryPolicy;
  /** Do the work. */
  execute(context: StageContext, input: I): Promise<StageOutcome<O>>;
}

/**
 * Thrown by a stage to stop at a gate (contract §11 "stop at required gates", §13).
 *
 * Provided as an alternative to returning `{ kind: "gate_required" }`, because a gate is often
 * discovered deep inside a stage where unwinding to a return value is awkward. The runner treats
 * both forms identically.
 */
export class GateRequiredSignal extends Error {
  readonly gateId: string;
  readonly subjectHashes: readonly string[];

  constructor(
    gateId: string,
    options: { subjectHashes?: readonly string[]; reason?: string } = {},
  ) {
    super(options.reason ?? `Stage stopped at gate "${gateId}" and is awaiting a decision.`);
    this.name = "GateRequiredSignal";
    this.gateId = gateId;
    this.subjectHashes = options.subjectHashes ?? [];
  }
}

/** Narrow an unknown thrown value to a {@link GateRequiredSignal}. */
export function isGateRequiredSignal(value: unknown): value is GateRequiredSignal {
  return value instanceof GateRequiredSignal;
}

/** Result of running a stage to a terminal state. */
export interface StageRunResult<O = unknown> {
  /** Final status of the stage execution (contract §6.3). */
  status: "succeeded" | "failed" | "waiting_for_gate" | "cancelled";
  /** Identity of the last attempt made. */
  attemptId: string;
  /** 1-based ordinal of the last attempt. */
  attempt: number;
  /** Validated output, present only when `status` is `succeeded`. */
  output?: O;
  /** Gate awaiting decision, present only when `status` is `waiting_for_gate`. */
  gateId?: string;
  /** Structured failure, present when `status` is `failed` or `cancelled`. */
  error?: StructuredError;
  /** Artifacts recorded across the final attempt, including on failure (contract §19.1). */
  outputArtifacts: ArtifactRef[];
}
