/**
 * Ports the TTS ledger reads and writes through.
 *
 * Contract §7 requires core models to be independent of physical storage, so this package depends
 * on no store implementation. Each interface is kept to the operations the ledger actually uses:
 * an aspirational method on a port is worse than an absent one, because a second adapter gets
 * written against it and only discovers at runtime that nothing honours it.
 *
 * Following WP-02 and WP-03, the ports stay in this package rather than moving to Core. §21's
 * extraction criterion is "at least one alternative adapter or test double proves
 * substitutability", and one adapter plus its in-memory twin is the same evidence WP-02 judged
 * insufficient. Moving them is a decision for whenever a second real adapter exists.
 */

import type { AldusEvent } from "@aldus/core";

import type { LexiconEntry } from "./lexicon.js";
import type { PerformanceScript } from "./performance.js";
import type { TtsRequestPlan } from "./request.js";
import type { TakeRecord } from "./take.js";

/**
 * Append-mostly storage for takes (contract §15, §15.1).
 *
 * There is **no delete**. §15.1 requires rejected paid takes to be retained with unique identity
 * until a retention policy allows cleanup, and an interface that cannot express deletion is a
 * stronger guarantee than one that merely declines to — the same reasoning the gate engine's
 * `GateDecisionStore` follows for decisions.
 *
 * `replace` exists only so a human decision can be attached to an existing take. It refuses to
 * change anything else; see `TtsLedger.decideTake`.
 */
export interface TakeStore {
  /** Every take recorded for a Run, in the order they were appended. */
  list(runId: string): Promise<TakeRecord[]>;
  /** Append one take. */
  append(runId: string, take: TakeRecord): Promise<void>;
  /** Replace one take in place, by `takeId`. Used only to attach a decision. */
  replace(runId: string, take: TakeRecord): Promise<void>;
}

/** Storage for request plans (contract §15). */
export interface PlanStore {
  list(runId: string): Promise<TtsRequestPlan[]>;
  append(runId: string, plan: TtsRequestPlan): Promise<void>;
}

/** Storage for performance scripts (contract §14). */
export interface ScriptStore {
  list(runId: string): Promise<PerformanceScript[]>;
  append(runId: string, script: PerformanceScript): Promise<void>;
}

/** Read access to the lexicon (contract §15.2). */
export interface LexiconStore {
  /** Every entry available to a Run. */
  list(runId: string): Promise<LexiconEntry[]>;
}

/**
 * Where lifecycle events go (contract §6.4).
 *
 * §6.4 requires **every** state mutation to emit an immutable event, so recording a take and
 * emitting its event are one operation from a caller's point of view.
 *
 * A caller wiring this to `@aldus/file-store`'s `FileEventStore` must not already hold the Run
 * lock: `append` takes that lock to assign a sequence (ADR-0005), and locks are not re-entrant —
 * `acquire` refuses with `ALDUS_LOCK_REENTRANT` rather than deadlocking. Give any enclosing
 * operation its own lock resource, as the stage runner does for its cache.
 */
export interface LedgerEventSink {
  emit(event: AldusEvent): Promise<void>;
}

/**
 * Decides whether a paid request may proceed (contract §13.2, §19.3).
 *
 * **This package never grants authorization.** §13.2 makes that a human gate decision, and
 * `@aldus/gate-engine` owns it — `GateEngine.authorizeSpend` satisfies this port directly. The
 * ledger asks, records the answer, and refuses to record a charge the answer did not permit.
 *
 * A narrow port rather than a dependency on the engine class, so a caller can wire whatever
 * authority model it has without this package taking a position on gate composition (§4.3).
 */
export interface SpendAuthorizer {
  /** Whether the plan may be synthesised, and under which decision. */
  authorize(request: AuthorizationQuery): Promise<AuthorizationOutcome>;
}

/** What the ledger asks a {@link SpendAuthorizer}. */
export interface AuthorizationQuery {
  runId: string;
  /** The plan about to be synthesised. */
  planId: string;
  /** Digest of the plan's scope, which §13.2 requires the approval to have bound. */
  planScopeSha256: string;
  /** Digests of everything §13.2 binds, from `planSubjectDigests`. */
  subjectDigests: Record<string, string>;
  /** What the request is expected to cost (contract §19.3). */
  estimatedCost?: { amount: string; currency: string };
}

/** What a {@link SpendAuthorizer} answers. */
export type AuthorizationOutcome =
  | {
      authorized: true;
      gateId: string;
      decisionId: string;
      grantId?: string;
      /** Digest of the plan scope the approval actually covered. */
      planScopeSha256: string;
    }
  | { authorized: false; explanation: string };

/** An in-memory {@link TakeStore}, for tests and for evaluation without persistence. */
export class MemoryTakeStore implements TakeStore {
  readonly #byRun = new Map<string, TakeRecord[]>();

  list(runId: string): Promise<TakeRecord[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  append(runId: string, take: TakeRecord): Promise<void> {
    const existing = this.#byRun.get(runId);
    if (existing === undefined) this.#byRun.set(runId, [take]);
    else existing.push(take);
    return Promise.resolve();
  }

  replace(runId: string, take: TakeRecord): Promise<void> {
    const existing = this.#byRun.get(runId) ?? [];
    const index = existing.findIndex((candidate) => candidate.takeId === take.takeId);
    if (index >= 0) existing[index] = take;
    return Promise.resolve();
  }
}

/** An in-memory {@link PlanStore}, for tests. */
export class MemoryPlanStore implements PlanStore {
  readonly #byRun = new Map<string, TtsRequestPlan[]>();

  list(runId: string): Promise<TtsRequestPlan[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  append(runId: string, plan: TtsRequestPlan): Promise<void> {
    const existing = this.#byRun.get(runId);
    if (existing === undefined) this.#byRun.set(runId, [plan]);
    else existing.push(plan);
    return Promise.resolve();
  }
}

/** An in-memory {@link ScriptStore}, for tests. */
export class MemoryScriptStore implements ScriptStore {
  readonly #byRun = new Map<string, PerformanceScript[]>();

  list(runId: string): Promise<PerformanceScript[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  append(runId: string, script: PerformanceScript): Promise<void> {
    const existing = this.#byRun.get(runId);
    if (existing === undefined) this.#byRun.set(runId, [script]);
    else existing.push(script);
    return Promise.resolve();
  }
}

/** An in-memory {@link LexiconStore}, for tests. */
export class MemoryLexiconStore implements LexiconStore {
  readonly entries: LexiconEntry[] = [];

  list(): Promise<LexiconEntry[]> {
    return Promise.resolve([...this.entries]);
  }
}

/** An in-memory {@link LedgerEventSink} that retains what it was given, for tests. */
export class MemoryLedgerEventSink implements LedgerEventSink {
  readonly events: AldusEvent[] = [];

  emit(event: AldusEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
