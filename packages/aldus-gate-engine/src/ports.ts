/**
 * Ports the gate engine reads and writes through.
 *
 * Contract §7 requires core models to be independent of physical storage. This package therefore
 * depends on no store implementation: an adopter wires these to `@aldus-runtime/file-store`'s `RunStore`
 * and `EventStore`, or to anything else that honours them. The in-memory implementations here are
 * for tests and for a caller evaluating gates without persisting anything.
 *
 * Each interface is kept to the operations this package actually uses. An aspirational method on
 * a port is worse than an absent one, because a second adapter is written against it and only
 * discovers at runtime that nothing honours it.
 */

import type { AldusEvent, CostRecord, GateDecision } from "@aldus-runtime/core";

/**
 * Append-only storage for gate decisions (contract §7 `approvals.json`).
 *
 * There is no update or delete. §13's decisions are an audit record: a rejection that was later
 * approved is two decisions, not one edited decision, and an interface that cannot express
 * mutation is a stronger guarantee than one that merely declines to.
 */
export interface GateDecisionStore {
  /** Every decision recorded for a Run, in the order they were appended. */
  list(runId: string): Promise<GateDecision[]>;
  /** Append one decision. */
  append(runId: string, decision: GateDecision): Promise<void>;
}

/** Read access to a Run's recorded costs (contract §7 `costs.json`). */
export interface CostReader {
  /** Every cost recorded for a Run. */
  list(runId: string): Promise<CostRecord[]>;
}

/**
 * Where lifecycle events go (contract §6.4).
 *
 * §6.4 requires **every** state mutation to emit an immutable event, so recording a decision and
 * emitting its event are one operation from a caller's point of view.
 */
export interface GateEventSink {
  /** Emit one event. */
  emit(event: AldusEvent): Promise<void>;
}

/** An in-memory {@link GateDecisionStore}, for tests and for evaluation without persistence. */
export class MemoryGateDecisionStore implements GateDecisionStore {
  readonly #byRun = new Map<string, GateDecision[]>();

  list(runId: string): Promise<GateDecision[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  append(runId: string, decision: GateDecision): Promise<void> {
    const existing = this.#byRun.get(runId);
    if (existing === undefined) this.#byRun.set(runId, [decision]);
    else existing.push(decision);
    return Promise.resolve();
  }
}

/** An in-memory {@link CostReader}, for tests. */
export class MemoryCostReader implements CostReader {
  readonly #byRun = new Map<string, CostRecord[]>();

  list(runId: string): Promise<CostRecord[]> {
    return Promise.resolve([...(this.#byRun.get(runId) ?? [])]);
  }

  /** Record a cost, as a stage would after a paid request. */
  add(record: CostRecord): void {
    const existing = this.#byRun.get(record.runId);
    if (existing === undefined) this.#byRun.set(record.runId, [record]);
    else existing.push(record);
  }
}

/** An in-memory {@link GateEventSink} that retains what it was given, for tests. */
export class MemoryGateEventSink implements GateEventSink {
  readonly events: AldusEvent[] = [];

  emit(event: AldusEvent): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
