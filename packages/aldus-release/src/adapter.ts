/**
 * The release adapter contract (architecture contract §17, §4.3).
 *
 * This package contains **no platform client, and names no platform.** Contract §4.2 keeps
 * publishing platforms out of the runtime and §1.2 explicitly rules out prescribing particular
 * release targets; §4.3 places provider and release configuration in Integration. Contract §22's
 * own wording for this work package names two platforms, and following that wording literally
 * would have put an adopter's channel semantics inside the runtime — the dependency direction
 * §4.3 forbids.
 *
 * So what lives here is the shape an adopter implements, plus the resumable machinery that shape
 * plugs into. The only implementation in this package is {@link RecordingReleaseAdapter}, a test
 * double.
 */

import type { ReleaseOperation } from "./operation.js";
import { ReleaseErrorCodes, releaseError } from "./errors.js";

/** What an adapter is asked to do. */
export interface ReleaseRequest {
  /** The operation being performed. */
  operation: ReleaseOperation;
  /**
   * The key that makes this request safe to repeat (contract §17, §19.1).
   *
   * An adapter whose platform supports client-supplied idempotency keys SHOULD pass this
   * through, so that a repeat caused by a lost response is deduplicated remotely as well as
   * locally.
   */
  idempotencyKey: string;
  /** Run the release belongs to. */
  runId: string;
}

/** What an adapter reports back. */
export type AdapterOutcome =
  | {
      status: "succeeded";
      /** Identifier assigned by the destination, where one is returned. */
      remoteId?: string;
      /** Address of the released item, where one is meaningful. */
      remoteUrl?: string;
    }
  | {
      status: "failed";
      /** Operator-facing reason, already redacted by the adapter (contract §19.2). */
      message: string;
      /** Whether repeating the identical request could plausibly succeed (contract §19.1). */
      retryable?: boolean;
    }
  | {
      /**
       * The outcome is genuinely unknown — a timeout, a lost connection after the request was
       * accepted, a platform that acknowledges asynchronously.
       *
       * Distinct from `failed` and the reason `ReleaseReceipt` has a `pending` status: an
       * unknown outcome MUST be reconciled against the destination rather than retried, because
       * retrying something that already succeeded is how a double publish happens.
       */
      status: "pending";
      message?: string;
    };

/** What reconciliation found at the destination. */
export interface RemoteState {
  /** Whether the destination holds the result of this operation. */
  exists: boolean;
  remoteId?: string;
  remoteUrl?: string;
}

/**
 * An adopter's implementation for one destination.
 *
 * Implementations live in an adopter integration, never here (§4.3).
 */
export interface ReleaseAdapter {
  /** The destination this adapter serves, matching `ReleaseOperation.destination`. */
  readonly destination: string;
  /** Perform one operation. */
  execute(request: ReleaseRequest): Promise<AdapterOutcome>;
  /**
   * Ask the destination whether an operation already happened (contract §17).
   *
   * Optional because §17 qualifies resumability with "where the platform allows it" — a
   * destination with no way to query prior state genuinely cannot support this. An adapter that
   * omits it makes reconciliation impossible for its operations, and the executor reports that
   * rather than guessing; see {@link ReleaseErrorCodes.RECONCILIATION_UNAVAILABLE}.
   */
  lookup?(request: ReleaseRequest): Promise<RemoteState>;
}

/** Adapters by destination. */
export class AdapterRegistry {
  readonly #byDestination = new Map<string, ReleaseAdapter>();

  constructor(adapters: readonly ReleaseAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  /** Register an adapter, replacing any previous one for its destination. */
  register(adapter: ReleaseAdapter): void {
    this.#byDestination.set(adapter.destination, adapter);
  }

  /** The adapter for a destination, or `undefined`. */
  find(destination: string): ReleaseAdapter | undefined {
    return this.#byDestination.get(destination);
  }

  /**
   * The adapter for a destination.
   *
   * @throws {AldusError} `ALDUS_RELEASE_ADAPTER_NOT_REGISTERED` when none is registered. Refusing
   * is deliberate: a missing adapter means an operator declared work nothing can perform, and
   * skipping it would report a complete release that never touched the destination.
   */
  require(destination: string): ReleaseAdapter {
    const adapter = this.#byDestination.get(destination);
    if (adapter === undefined) {
      throw releaseError(
        ReleaseErrorCodes.ADAPTER_NOT_REGISTERED,
        `No release adapter is registered for destination "${destination}".`,
        { category: "validation", retryable: false, details: { destination } },
      );
    }
    return adapter;
  }
}

/** Scripted behaviour for {@link RecordingReleaseAdapter}. */
export interface RecordingAdapterOptions {
  /** Outcome per `operationId`. Anything unlisted succeeds. */
  outcomes?: Readonly<Record<string, AdapterOutcome>>;
  /** Remote state per idempotency key, as reconciliation would find it. */
  remote?: Readonly<Record<string, RemoteState>>;
  /** Omit `lookup` entirely, modelling a destination that cannot be queried. */
  withoutLookup?: boolean;
}

/**
 * A test double that records what it was asked to do.
 *
 * Counting executions is the point: the double-publish tests assert that a *real* second
 * execution never happened, which a spy on the executor could not establish.
 */
export class RecordingReleaseAdapter implements ReleaseAdapter {
  readonly destination: string;
  /** Every request passed to {@link execute}, in order. */
  readonly executed: ReleaseRequest[] = [];
  /** Every request passed to {@link lookup}, in order. */
  readonly lookedUp: ReleaseRequest[] = [];
  readonly #options: RecordingAdapterOptions;
  /** Remote state, mutable so a test can simulate a destination that already holds a result. */
  readonly remote: Map<string, RemoteState>;

  /**
   * Present only when the destination can be queried.
   *
   * An own property assigned in the constructor rather than a prototype method, because
   * `withoutLookup` has to make `lookup` genuinely **absent**. A method that returns "not found"
   * would be indistinguishable from a destination that was queried and had nothing — and those
   * are opposite situations: one means the operation still needs to run, the other means nobody
   * can say. Deleting a prototype method does not remove it from the instance, which is the bug
   * this shape avoids.
   */
  readonly lookup?: (request: ReleaseRequest) => Promise<RemoteState>;

  constructor(destination: string, options: RecordingAdapterOptions = {}) {
    this.destination = destination;
    this.#options = options;
    this.remote = new Map(Object.entries(options.remote ?? {}));
    if (options.withoutLookup !== true) {
      this.lookup = (request: ReleaseRequest): Promise<RemoteState> => {
        this.lookedUp.push(request);
        return Promise.resolve(this.remote.get(request.idempotencyKey) ?? { exists: false });
      };
    }
  }

  execute(request: ReleaseRequest): Promise<AdapterOutcome> {
    this.executed.push(request);
    const scripted = this.#options.outcomes?.[request.operation.operationId];
    const outcome: AdapterOutcome = scripted ?? {
      status: "succeeded",
      remoteId: `remote-${request.operation.operationId}`,
    };
    if (outcome.status === "succeeded") {
      this.remote.set(request.idempotencyKey, {
        exists: true,
        ...(outcome.remoteId === undefined ? {} : { remoteId: outcome.remoteId }),
        ...(outcome.remoteUrl === undefined ? {} : { remoteUrl: outcome.remoteUrl }),
      });
    }
    return Promise.resolve(outcome);
  }

  /** How many times an operation was actually sent to the destination. */
  executionCount(operationId: string): number {
    return this.executed.filter((request) => request.operation.operationId === operationId).length;
  }
}
