/**
 * Gate evaluation, decision recording, and authorization (architecture contract §12, §13, §19.3).
 *
 * The central design choice: **invalidation is derived, never stored.**
 *
 * Contract §13.1 requires a content-changing edit to invalidate the Content Freeze "and
 * downstream approvals". The obvious implementation writes invalidation records and walks the
 * graph marking approvals dead. That implementation has a failure mode the contract cannot
 * tolerate — if the cascade is ever interrupted, or a gate is added after the fact, some approval
 * stays marked valid while the thing it approved has moved underneath it, and §13.2 forbids
 * exactly that.
 *
 * So nothing is marked. A gate's state is computed on every evaluation from three inputs: its
 * latest decision, the current digests of what it binds, and the state of the gates it depends
 * on. A stale approval cannot survive because there is no stored "valid" flag for it to survive
 * in. Adding a dependency edge invalidates downstream approvals immediately, with no migration.
 */

import type { ActorRef, AldusEvent, CostRecord, GateDecision } from "@aldus-runtime/core";
import { SCHEMA_VERSION, newEventId, newGateDecisionId, validate } from "@aldus-runtime/core";

import {
  assertSubjectsCover,
  detectDrift,
  type GateSubject,
  type SubjectDrift,
} from "./binding.js";
import type {
  GateEnforcement,
  GateLevel,
  GateRegistry,
  ResolvedGateDefinition,
} from "./definition.js";
import { GateEngineErrorCodes, gateEngineError } from "./errors.js";
import type { CostReader, GateDecisionStore, GateEventSink } from "./ports.js";
import {
  checkSpend,
  grantTermsDigest,
  type SpendCheck,
  type SpendGrant,
  type SpendRequest,
} from "./spend.js";

/**
 * What a gate currently is.
 *
 * `stale` is deliberately distinct from `pending`: a gate that was approved and then drifted is
 * not the same operator situation as one nobody has looked at, and §13.1 wants the difference
 * visible. `blocked_upstream` is likewise distinct from both — the gate itself may be perfectly
 * approved while something it depends on is not.
 */
export const GATE_STATES = [
  /** No decision has been recorded. */
  "pending",
  // NOTE: `blocked_upstream` below is used only when a gate is otherwise fine. A gate that is
  // itself stale or rejected keeps that state and carries `blockedBy` alongside it, because the
  // more specific label is the one an operator can act on.
  /** Approved, and still bound to the current inputs. */
  "satisfied",
  /** Approved, but a bound value has changed since (§13.1, §13.2). */
  "stale",
  /** The operator rejected it. */
  "rejected",
  /** The operator asked for changes. */
  "changes_requested",
  /** The operator deliberately bypassed the check (§13, distinct from approval). */
  "waived",
  /** A blocking gate this one depends on is not satisfied (§13.1 cascade). */
  "blocked_upstream",
] as const;

/** @see GATE_STATES */
export type GateState = (typeof GATE_STATES)[number];

/** The evaluated state of one gate. */
/** `"a"`, `"a and b"`, `"a, b and c"` — for a sentence an operator reads, not a log line. */
function formatKeys(keys: readonly string[]): string {
  const quoted = keys.map((key) => `"${key}"`);
  if (quoted.length <= 1) return quoted[0] ?? "";
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1] as string}`;
}

export interface GateStatus {
  gateId: string;
  state: GateState;
  /** What kind of judgement this gate represents (§12). */
  level: GateLevel;
  /** Whether it stops work or merely reports (§12). */
  enforcement: GateEnforcement;
  /** The decision this state was computed from, if any. */
  decision?: GateDecision;
  /** Which bound values moved, when `state` is `stale`. */
  drift?: SubjectDrift;
  /** Gates that blocked this one, when `state` is `blocked_upstream`. */
  blockedBy?: string[];
  /**
   * Bound values nobody has supplied yet, when the gate is otherwise decidable (#91).
   *
   * §13.2 requires an authorization to bind every listed value, so a gate whose subjects are
   * only partly supplied cannot be approved — `assertSubjectsCover` refuses it. Reported here so
   * that a caller can say why before offering the decision, rather than recommending a command
   * that will be rejected.
   *
   * Absent when every bound value is present, which is the ordinary case.
   */
  missingSubjects?: string[];
  /** Operator-facing explanation of why work may not proceed past this gate. */
  explanation?: string;
  /**
   * Whether this state stops work.
   *
   * An advisory gate is never blocking whatever its state — §12 level 2 "reports a possible issue
   * without blocking" — which is why enforcement and state are separate fields rather than one
   * conflated verdict.
   */
  blocking: boolean;
}

/** Current digests of what each gate binds, keyed by gate. */
export type SubjectsByGate = Readonly<Record<string, readonly GateSubject[]>>;

/** True if two id lists hold the same ids in the same order. */
function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** What {@link GateEngine.decide} needs. */
export interface DecideInput {
  runId: string;
  gateId: string;
  decision: GateDecision["decision"];
  /** Current digests of everything the gate binds. */
  subjects: readonly GateSubject[];
  /** Who decided (§19.2). */
  decidedBy: ActorRef;
  /** ISO-8601 timestamp with offset. */
  decidedAt: string;
  comment?: string;
  /** Canonical Episode identity, for the emitted event (§6.4). */
  episodeId: string;
  /** Overrides the gate's default. Defaults to the definition's `expiresOnChange`. */
  expiresOnChange?: boolean;
  /** Supplied for deterministic tests; defaults to a fresh ULID-based id. */
  decisionId?: string;
  /** Supplied for deterministic tests; defaults to a fresh ULID-based id. */
  eventId?: string;
}

/** Why an operation was refused. */
export interface AuthorizationRefusal {
  authorized: false;
  /** Gates that could have authorized the operation, and why none did. */
  statuses: GateStatus[];
  explanation: string;
}

/** An operation the engine permits. */
export interface AuthorizationGrant {
  authorized: true;
  /** The gate whose approval authorized it. */
  gateId: string;
  decision: GateDecision;
}

/** Outcome of an authorization check. */
export type AuthorizationResult = AuthorizationGrant | AuthorizationRefusal;

/** Outcome of a spend authorization: the gate check and the budget check together. */
export type SpendAuthorization =
  | {
      authorized: true;
      gateId: string;
      decision: GateDecision;
      check: Extract<SpendCheck, { allowed: true }>;
    }
  | { authorized: false; explanation: string; statuses?: GateStatus[]; check?: SpendCheck };

/** Wiring for a {@link GateEngine}. */
export interface GateEngineOptions {
  registry: GateRegistry;
  decisions: GateDecisionStore;
  events: GateEventSink;
  costs?: CostReader;
}

/**
 * Evaluates gates, records decisions, and authorizes operations and spend.
 */
export class GateEngine {
  readonly #registry: GateRegistry;
  readonly #decisions: GateDecisionStore;
  readonly #events: GateEventSink;
  readonly #costs: CostReader | undefined;

  constructor(options: GateEngineOptions) {
    this.#registry = options.registry;
    this.#decisions = options.decisions;
    this.#events = options.events;
    this.#costs = options.costs;
  }

  /** The gate definitions this engine evaluates. */
  get registry(): GateRegistry {
    return this.#registry;
  }

  /**
   * Record a human decision (contract §3.6).
   *
   * §3.6: "Human review MUST create a durable `GateDecision`. A chat message saying 'looks good'
   * is not enough unless it is translated into a recorded decision tied to exact inputs." This is
   * that translation, and it refuses anything that would produce a decision tied to less than the
   * gate binds.
   *
   * @throws {AldusError} `ALDUS_GATE_NOT_FOUND` if the gate is not registered.
   * @throws {AldusError} `ALDUS_GATE_SUBJECTS_INCOMPLETE` if the subjects do not cover the gate.
   * @throws {AldusError} `ALDUS_GATE_ACTOR_NOT_PERMITTED` if the actor may not decide this gate.
   */
  async decide(input: DecideInput): Promise<GateDecision> {
    const gate = this.#registry.require(input.gateId);
    assertSubjectsCover(gate, input.subjects);

    if (!gate.permittedActorKinds.includes(input.decidedBy.kind)) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_ACTOR_NOT_PERMITTED,
        `Gate "${gate.gateId}" accepts decisions from [${gate.permittedActorKinds.join(", ")}], ` +
          `but "${input.decidedBy.id}" is a ${input.decidedBy.kind}. Contract §12 forbids ` +
          "presenting a machine pass as semantic correctness, and §13.3 keeps final performance " +
          "approval human-owned.",
        {
          category: "policy",
          details: {
            gateId: gate.gateId,
            actorKind: input.decidedBy.kind,
            permitted: [...gate.permittedActorKinds],
          },
        },
      );
    }

    // A waiver is not an approval, and the two refusals below are what keep it from becoming one.
    //
    // **It must not outlive the content it was granted against.** `expiresOnChange` is a per-
    // decision override of the gate's default, which is defensible for an *approval* whose subject
    // cannot drift. A non-expiring **waiver** says the check stays bypassed whatever the content
    // becomes — that is a config flag disabling a gate, reached through the decision API instead of
    // the config file, and it is precisely what this design exists to avoid.
    //
    // Closing it is also what makes the rest safe. Every gate being waivable — `release.public`
    // included — is defensible **only** because a waiver cannot survive the subjects moving. Leave
    // the override open and every gate needs a non-waivable declaration; close it and none does.
    //
    // **And it must say why.** A waiver with no reason is a blank with a timestamp: the one thing a
    // reader of the approvals log needs from it is the part that would be missing.
    if (input.decision === "waived") {
      if (input.expiresOnChange === false) {
        throw gateEngineError(
          GateEngineErrorCodes.GATE_WAIVER_INVALID,
          `A waiver of gate "${gate.gateId}" may not be recorded as non-expiring. A waiver says ` +
            "the check was bypassed rather than passed, so it must not outlive the content it was " +
            "granted against (§13.1, §13.2).",
          { category: "policy", details: { gateId: gate.gateId } },
        );
      }
      if (input.comment === undefined || input.comment.trim() === "") {
        throw gateEngineError(
          GateEngineErrorCodes.GATE_WAIVER_INVALID,
          `A waiver of gate "${gate.gateId}" needs a reason. An approval records that the content ` +
            "was judged; a waiver records that the check was bypassed, and without a reason the " +
            "log carries a blank with a timestamp (§13.3, §19.2).",
          { category: "validation", details: { gateId: gate.gateId } },
        );
      }
    }

    const decision: GateDecision = {
      schemaVersion: SCHEMA_VERSION,
      decisionId: input.decisionId ?? newGateDecisionId(),
      gateId: gate.gateId,
      runId: input.runId,
      decision: input.decision,
      subjectHashes: [...input.subjects].map((subject) => subject.sha256).sort(),
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
      // Forced for a waiver, never taken from the gate default or the caller. See above.
      expiresOnChange:
        input.decision === "waived" ? true : (input.expiresOnChange ?? gate.expiresOnChange),
    };

    // Validate before persisting. A malformed decision written to the approvals log is worse
    // than a rejected call, because §13 treats what is written there as authoritative.
    const validated = validate("GateDecision", decision);
    if (!validated.ok) {
      throw gateEngineError(
        GateEngineErrorCodes.GATE_DEFINITION_INVALID,
        `The decision built for gate "${gate.gateId}" is not a valid GateDecision.`,
        { category: "internal", details: { issues: validated.error.details } },
      );
    }

    await this.#decisions.append(input.runId, decision);
    await this.#emitDecisionEvent(input, decision);
    return decision;
  }

  /** Emit the §6.4 event for a recorded decision. */
  async #emitDecisionEvent(input: DecideInput, decision: GateDecision): Promise<void> {
    const event: AldusEvent = {
      schemaVersion: SCHEMA_VERSION,
      eventId: input.eventId ?? newEventId(),
      occurredAt: decision.decidedAt,
      episodeId: input.episodeId,
      runId: decision.runId,
      action: `gate.${decision.decision}`,
      actor: decision.decidedBy,
      inputRefs: [],
      outputRefs: [],
      details: {
        gateId: decision.gateId,
        decisionId: decision.decisionId,
        subjectCount: decision.subjectHashes.length,
        expiresOnChange: decision.expiresOnChange,
      },
    };
    await this.#events.emit(event);
  }

  /**
   * Evaluate every registered gate for a Run.
   *
   * `subjects` supplies the current digests of what each gate binds. A gate absent from it is
   * evaluated as having no current inputs, which reads as `pending` — never as satisfied.
   */
  async evaluate(runId: string, subjects: SubjectsByGate): Promise<Map<string, GateStatus>> {
    const decisions = await this.#decisions.list(runId);
    return this.evaluateWith(decisions, subjects);
  }

  /**
   * Evaluate against a decision list already in hand.
   *
   * Separated from {@link GateEngine.evaluate} so the whole cascade is a pure function of its
   * inputs — which is what makes it testable without a store and impossible to get into a
   * partially-updated state.
   */
  evaluateWith(
    decisions: readonly GateDecision[],
    subjects: SubjectsByGate,
  ): Map<string, GateStatus> {
    const own = new Map<string, GateStatus>();
    for (const gate of this.#registry.list()) {
      own.set(gate.gateId, this.#evaluateOne(gate, decisions, subjects[gate.gateId] ?? []));
    }
    return this.#applyCascade(own);
  }

  /** A gate's state from its own decision and subjects, before the cascade. */
  #evaluateOne(
    gate: ResolvedGateDefinition,
    decisions: readonly GateDecision[],
    subjects: readonly GateSubject[],
  ): GateStatus {
    const base = { gateId: gate.gateId, level: gate.level, enforcement: gate.enforcement };
    const blocks = (state: GateState): boolean =>
      gate.enforcement === "blocking" && state !== "satisfied" && state !== "waived";

    // Append order is authoritative, not `decidedAt`: the log is the durable fact, and two
    // machines with disagreeing clocks must not be able to reorder which approval is current.
    const latest = [...decisions].reverse().find((entry) => entry.gateId === gate.gateId);

    const suppliedKeys = new Set(subjects.map((entry) => entry.key));
    const missingSubjects = gate.binds.filter((key) => !suppliedKeys.has(key));

    if (latest === undefined) {
      return {
        ...base,
        state: "pending",
        blocking: blocks("pending"),
        // Naming the missing values rather than only the absence of a decision: an operator told
        // "no recorded decision" goes looking for who forgot to approve, when the answer is that
        // nothing has produced what the approval would bind (§13.2).
        explanation:
          missingSubjects.length > 0
            ? `Gate "${gate.gateId}" has no recorded decision, and ` +
              `${formatKeys(missingSubjects)} ${missingSubjects.length === 1 ? "has" : "have"} ` +
              "not been supplied, so it cannot be decided yet."
            : `Gate "${gate.gateId}" has no recorded decision.`,
        ...(missingSubjects.length > 0 ? { missingSubjects } : {}),
      };
    }

    if (latest.decision === "rejected" || latest.decision === "changes_requested") {
      return {
        ...base,
        state: latest.decision,
        decision: latest,
        blocking: blocks(latest.decision),
        explanation:
          latest.comment ?? `Gate "${gate.gateId}" was ${latest.decision.replace("_", " ")}.`,
      };
    }

    const drift = detectDrift(latest, subjects);

    // A waiver records that a check was bypassed (§13). It still binds: waiving a gate for one
    // version of the content says nothing about the next, so drift voids it exactly as it voids
    // an approval.
    if (drift !== undefined && latest.expiresOnChange) {
      return {
        ...base,
        state: "stale",
        decision: latest,
        drift,
        blocking: blocks("stale"),
        explanation:
          `Gate "${gate.gateId}" was ${latest.decision}, but ` +
          `${drift.changed.length > 0 ? `[${drift.changed.join(", ")}] changed` : "its bound inputs changed"}` +
          " since. Contract §13.1 voids an approval once what it approved has moved.",
      };
    }

    const state: GateState = latest.decision === "waived" ? "waived" : "satisfied";
    return { ...base, state, decision: latest, blocking: blocks(state) };
  }

  /**
   * Propagate §13.1's cascade over the dependency graph.
   *
   * Only **blocking** gates propagate. §12 level 2 defines an advisory signal as one that
   * "reports a possible issue without blocking", so an un-run advisory check must not halt the
   * gates downstream of it — otherwise every advisory would be a hard gate wearing a different
   * label, and §12's four levels would collapse into two.
   */
  #applyCascade(own: Map<string, GateStatus>): Map<string, GateStatus> {
    const result = new Map(own);
    // Registry construction already refused a cycle, so a fixpoint loop terminates. Bounding it
    // by the gate count keeps a future graph bug from hanging an operator's session regardless.
    for (let pass = 0; pass < result.size + 1; pass += 1) {
      let changed = false;
      for (const gate of this.#registry.list()) {
        const current = result.get(gate.gateId);
        if (current === undefined) continue;

        const blockedBy = gate.dependsOn.filter((dependency) => {
          const upstream = result.get(dependency);
          return upstream !== undefined && upstream.blocking;
        });
        if (blockedBy.length === 0) continue;
        if (current.blockedBy !== undefined && sameIds(current.blockedBy, blockedBy)) continue;

        // A gate can be broken on its own account *and* blocked by something upstream. When it
        // has a decision that is itself broken, that state wins: an operator told only "blocked
        // upstream" would fix the upstream gate and be surprised this one still needs
        // re-approving. `blockedBy` is set either way, so the cascade is never lost.
        //
        // A `pending` gate has no such decision to preserve, and there "blocked upstream" is the
        // more useful label — it says the gate cannot even be started on yet, rather than merely
        // that nobody has.
        const ownStateIsInformative =
          current.state === "stale" ||
          current.state === "rejected" ||
          current.state === "changes_requested";
        const state: GateState = ownStateIsInformative ? current.state : "blocked_upstream";
        const upstreamNote =
          `[${blockedBy.join(", ")}] is not satisfied, so contract §13.1 invalidates this ` +
          "approval along with the gate it depends on.";

        result.set(gate.gateId, {
          ...current,
          state,
          blockedBy,
          blocking: gate.enforcement === "blocking",
          explanation: ownStateIsInformative
            ? `${current.explanation ?? `Gate "${gate.gateId}" is ${current.state}.`} Additionally, ${upstreamNote}`
            : `Gate "${gate.gateId}" cannot be relied on because ${upstreamNote}`,
        });
        changed = true;
      }
      if (!changed) break;
    }
    return result;
  }

  /**
   * Whether an operation is authorized (contract §13.4).
   *
   * An approval authorizes exactly the operations its gate names in `grants` and nothing else.
   * That is what keeps §13.4's "Uploading and making public SHOULD be separate operations"
   * enforceable: they are two gates granting two operations, and approving one leaves the other
   * refused.
   *
   * Returns a refusal rather than throwing, because a caller needs to display why an operation is
   * unavailable.
   */
  async authorize(
    runId: string,
    operation: string,
    subjects: SubjectsByGate,
  ): Promise<AuthorizationResult> {
    const statuses = await this.evaluate(runId, subjects);
    const candidates = this.#registry.list().filter((gate) => gate.grants.includes(operation));

    if (candidates.length === 0) {
      return {
        authorized: false,
        statuses: [],
        explanation:
          `No registered gate grants "${operation}". An operation nobody authorizes is refused ` +
          "rather than allowed, so that adding a gate is what enables an action, never omitting one.",
      };
    }

    const relevant = candidates.flatMap((gate) => {
      const status = statuses.get(gate.gateId);
      return status === undefined ? [] : [status];
    });

    const granted = relevant.find(
      (status) => status.state === "satisfied" && status.decision?.decision === "approved",
    );
    if (granted?.decision !== undefined) {
      return { authorized: true, gateId: granted.gateId, decision: granted.decision };
    }

    return {
      authorized: false,
      statuses: relevant,
      explanation:
        `"${operation}" is not authorized. ` +
        relevant
          .map(
            (status) =>
              `${status.gateId}: ${status.state}${status.explanation === undefined ? "" : ` — ${status.explanation}`}`,
          )
          .join("; "),
    };
  }

  /**
   * Whether a paid request may proceed (contract §13.2, §19.3).
   *
   * Three things must hold, and all three are checked here because any one of them alone is
   * insufficient:
   *
   * 1. the gate is satisfied — §13.2 forbids paid synthesis before the operator approves;
   * 2. the grant's limits are among what that decision bound — otherwise the ceiling could be
   *    raised after approval without voiding it;
   * 3. the spend fits the remaining budget — §19.3 stop-on-budget.
   */
  async authorizeSpend(
    runId: string,
    grant: SpendGrant,
    request: SpendRequest,
    subjects: SubjectsByGate,
    costs?: readonly CostRecord[],
  ): Promise<SpendAuthorization> {
    const statuses = await this.evaluate(runId, subjects);
    const status = statuses.get(grant.gateId);

    if (status === undefined) {
      return {
        authorized: false,
        explanation: `Gate "${grant.gateId}" is not registered, so it cannot authorize spend.`,
      };
    }

    if (status.state !== "satisfied" || status.decision?.decision !== "approved") {
      return {
        authorized: false,
        statuses: [status],
        explanation:
          `Paid work is refused: gate "${grant.gateId}" is ${status.state}. Contract §13.2 ` +
          "forbids paid synthesis until the operator has approved, and voids that approval once " +
          `any bound value changes.${status.explanation === undefined ? "" : ` ${status.explanation}`}`,
      };
    }

    const decision = status.decision;
    if (decision.decisionId !== grant.decisionId) {
      return {
        authorized: false,
        statuses: [status],
        explanation:
          `The grant cites decision "${grant.decisionId}", but the current decision on gate ` +
          `"${grant.gateId}" is "${decision.decisionId}". A grant from a superseded decision ` +
          "does not carry forward (§13.2).",
      };
    }

    if (!decision.subjectHashes.includes(grantTermsDigest(grant))) {
      return {
        authorized: false,
        statuses: [status],
        explanation:
          `The authorized maximum of ${grant.maxTotal.amount} ${grant.maxTotal.currency} is not ` +
          `among what decision "${decision.decisionId}" bound. Contract §13.2 requires the ` +
          "operator to approve a maximum authorized cost; a limit the approval never covered is " +
          "not an authorization.",
      };
    }

    const recorded = costs ?? (this.#costs === undefined ? [] : await this.#costs.list(runId));
    const check = checkSpend(grant, recorded, request);
    if (!check.allowed) {
      return { authorized: false, explanation: check.explanation, statuses: [status], check };
    }

    return { authorized: true, gateId: grant.gateId, decision, check };
  }
}
