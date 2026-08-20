/**
 * Test doubles for the Worker seam (contract §3.2, §4.1; ADR-0035).
 *
 * Shipped from this package rather than the testkit, because `stage-runner` devDepends on the
 * testkit and the reverse edge would close a cycle. It also puts the double beside the contract it
 * doubles, which is where `RecordingReleaseAdapter` already sits for releases.
 *
 * An adopter writing a Worker needs to test the Stage that invokes it without running the real
 * operation — a render, a paid synthesis — and needs to test their Worker without a Stage. These
 * are the two halves of that.
 *
 * Deliberately not a mocking framework. Each double records what it was handed, because the thing
 * most worth asserting about a Worker invocation is the identity the runtime supplied: a Worker
 * cannot state its own run, stage or attempt, and a test proving that is a test proving the trace
 * is attributable.
 */

import type { Worker, WorkerCapabilities, WorkerRequest, WorkerResult } from "./worker.js";

/** A Worker that records every invocation, for asserting what the runtime supplied. */
export interface RecordingWorker<I = unknown, O = unknown> extends Worker<I, O> {
  /** Every request this Worker was handed, in order. */
  readonly calls: readonly WorkerRequest<I>[];
  /** Capability lookups, so a test can prove the check ran before `execute` (§10, §11). */
  readonly capabilityChecks: number;
}

/** Options for {@link recordingWorker}. */
export interface RecordingWorkerOptions<I = unknown, O = unknown> {
  id?: string;
  version?: string;
  /** Capabilities to offer. Defaults to none, which is the fail-closed case worth testing. */
  offers?: readonly string[];
  /** What to return. Defaults to echoing the input, so a test asserts plumbing rather than logic. */
  execute?: (request: WorkerRequest<I>) => Promise<WorkerResult<O>> | WorkerResult<O>;
}

/**
 * A Worker that succeeds and remembers what it was asked.
 *
 * The default `offers` is empty rather than permissive. A double that offers everything makes a
 * capability check pass in every test, including the ones written to prove it refuses — and a
 * check that cannot be observed refusing is the shape this seam exists to avoid (ADR-0030).
 */
export function recordingWorker<I = unknown, O = unknown>(
  options: RecordingWorkerOptions<I, O> = {},
): RecordingWorker<I, O> {
  const calls: WorkerRequest<I>[] = [];
  let capabilityChecks = 0;
  const offers = options.offers ?? [];

  return {
    id: options.id ?? "worker-a",
    version: options.version ?? "1",
    capabilities: (): Promise<WorkerCapabilities> => {
      capabilityChecks += 1;
      return Promise.resolve({ offers });
    },
    execute: async (request: WorkerRequest<I>): Promise<WorkerResult<O>> => {
      calls.push(request);
      if (options.execute !== undefined) return await options.execute(request);
      return { output: request.input as unknown as O };
    },
    get calls() {
      return calls;
    },
    get capabilityChecks() {
      return capabilityChecks;
    },
  };
}

/**
 * A Worker that fails, so a Stage's error path can be exercised without a real failure.
 *
 * Throws rather than returning an unsuccessful result, because that is what a real Worker does
 * when the operation it wraps fails: §11 leaves the outcome shape to the Stage, and a Worker
 * reporting failure as data would make every Stage remember to check it.
 */
export function failingWorker(
  options: { id?: string; version?: string; message?: string } = {},
): Worker {
  return {
    id: options.id ?? "worker-a",
    version: options.version ?? "1",
    capabilities: () => Promise.resolve({ offers: [] }),
    execute: () => Promise.reject(new Error(options.message ?? "the operation failed")),
  };
}

/**
 * A Worker that waits for its cancellation signal, for testing §19.1's cancellation path.
 *
 * Observes `request.signal` rather than a timer the test controls, because that is the contract:
 * `AbortSignal` is the primary mechanism and `Worker.cancel` exists only for executions that
 * cannot see one. A double that ignored the signal would let a Stage pass a cancellation test it
 * would fail in production.
 */
export function cancellableWorker(options: { id?: string; version?: string } = {}): Worker {
  return {
    id: options.id ?? "worker-a",
    version: options.version ?? "1",
    capabilities: () => Promise.resolve({ offers: [] }),
    execute: (request) =>
      new Promise((_resolve, reject) => {
        if (request.signal.aborted) {
          reject(request.signal.reason ?? new Error("cancelled"));
          return;
        }
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason ?? new Error("cancelled")),
          { once: true },
        );
      }),
  };
}
