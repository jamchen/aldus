/**
 * Wiring the gate engine's ports to file-backed storage.
 *
 * `@aldus-runtime/gate-engine` depends on no store implementation (contract §7), so something has to
 * join the two. This is that something, and it is deliberately the thinnest possible layer: each
 * adapter forwards one call and adds no behaviour, because behaviour added here would be
 * invisible to anyone reading either package.
 *
 * ## The lock hazard this file has to respect
 *
 * `FileEventStore.append` takes the Run lock to assign an event sequence (ADR-0005), and
 * `FileRunStore.addRecord` takes the same lock to append to a collection file. File locks are not
 * re-entrant, and `acquire` now refuses a re-entrant attempt outright with
 * `ALDUS_LOCK_REENTRANT` rather than deadlocking.
 *
 * So these adapters take the Run lock **sequentially, never nested**, and nothing in this package
 * may wrap a `GateEngine.decide` call inside `withLock(runLockResource(runId), …)`. That is not a
 * style preference — it is refused at runtime, and there is a test that proves the refusal fires.
 *
 * ## Why that is safe, given §6.4
 *
 * §6.4 requires every state mutation to emit an event, and `decide` writes the decision and then
 * emits the event as two separate locked operations. A crash between them leaves a decision with
 * no event.
 *
 * That gap is a **trace** gap, not a correctness one, and the reason is structural: the gate
 * engine derives every gate's state from `GateDecisionStore.list`, never from the event log
 * (ADR-0009 — "invalidation is derived, never stored"). A missing event cannot make a stale
 * approval read as valid, because no gate state is ever read out of the log. Production trace
 * (§20) is poorer for the missing line; §13's safety properties are untouched.
 *
 * Making the pair atomic would require both files under one lock, which is exactly the nesting
 * the guard refuses — and buying a complete trace at the price of a deadlock is a bad trade.
 */

import type { AldusEvent, CostRecord, GateDecision } from "@aldus-runtime/core";
import type { EventStore, RunStore } from "@aldus-runtime/file-store";
import type { CostRecordStore } from "./cost-store.js";
import type { CostReader, GateDecisionStore, GateEventSink } from "@aldus-runtime/gate-engine";
import type { LedgerEventSink } from "@aldus-runtime/tts-ledger";

/**
 * A {@link GateDecisionStore} backed by a Run's `approvals.json` (contract §7).
 *
 * Append-only, matching both the port and the file: §13's decisions are an audit record, and a
 * rejection later approved is two decisions rather than one edited decision.
 */
export class RunStoreGateDecisionStore implements GateDecisionStore {
  readonly #runs: RunStore;

  constructor(runs: RunStore) {
    this.#runs = runs;
  }

  list(runId: string): Promise<GateDecision[]> {
    return this.#runs.listRecords(runId, "approvals");
  }

  append(runId: string, decision: GateDecision): Promise<void> {
    return this.#runs.addRecord(runId, "approvals", decision);
  }
}

/** A {@link CostReader} backed by a Run's `costs.json` (contract §7, §19.3). */
export class RunStoreCostReader implements CostReader {
  readonly #runs: RunStore;

  constructor(runs: RunStore) {
    this.#runs = runs;
  }

  list(runId: string): Promise<CostRecord[]> {
    return this.#runs.listRecords(runId, "costs");
  }
}

/**
 * Reads **and writes** the Run's cost collection (§19.3; #107, #160).
 *
 * The collection existed and nothing wrote to it, which is why an adopter's `aldus costs` reported
 * zero while real money was being spent. Reading was wired; recording was not.
 */
export class RunStoreCostRecordStore implements CostRecordStore {
  readonly #runs: RunStore;

  constructor(runs: RunStore) {
    this.#runs = runs;
  }

  list(runId: string): Promise<CostRecord[]> {
    return this.#runs.listRecords(runId, "costs");
  }

  async append(runId: string, record: CostRecord): Promise<void> {
    // Idempotent on cost id, so a settlement retry re-appends the same identity rather than
    // counting the charge twice (ADR-0044).
    const existing = await this.#runs.listRecords(runId, "costs");
    if (existing.some((entry) => entry.costId === record.costId)) return;
    await this.#runs.addRecord(runId, "costs", record);
  }
}

/**
 * A {@link GateEventSink} backed by the append-only event log (contract §6.4).
 *
 * `append` assigns the event's per-run sequence under the Run lock (ADR-0005), so this must never
 * be called from inside that lock. See this module's header.
 */
export class EventStoreGateEventSink implements GateEventSink {
  readonly #events: EventStore;

  constructor(events: EventStore) {
    this.#events = events;
  }

  async emit(event: AldusEvent): Promise<void> {
    await this.#events.append(event.runId, event);
  }
}

/**
 * A {@link LedgerEventSink} backed by the append-only event log (contract §6.4, §15).
 *
 * Structurally identical to {@link EventStoreGateEventSink} and deliberately not merged with it:
 * the two satisfy different packages' ports, and a shared class would make either package's port
 * unable to change without the other's consent. The duplication is four lines; the coupling would
 * outlast it.
 *
 * The same lock caution applies — see this module's header.
 */
export class LedgerEventStoreSink implements LedgerEventSink {
  readonly #events: EventStore;

  constructor(events: EventStore) {
    this.#events = events;
  }

  async emit(event: AldusEvent): Promise<void> {
    await this.#events.append(event.runId, event);
  }
}
