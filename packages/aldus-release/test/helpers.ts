/**
 * Shared test scaffolding.
 *
 * Destinations are `destination-a` and `destination-b` throughout. Naming a real platform here
 * would put an adopter's channel semantics inside the runtime (§4.2), and CI greps this directory
 * for exactly that.
 */

import type { ActorRef } from "@aldus/core";

import {
  AdapterRegistry,
  RecordingReleaseAdapter,
  type RecordingAdapterOptions,
} from "../src/adapter.js";
import { bestEffortOperation, requiredOperation } from "../src/operation.js";
import type { ReleaseBundle } from "../src/bundle.js";
import {
  MemoryReleaseEventSink,
  MemoryReleaseReceiptStore,
  type ReleaseReceiptStore,
} from "../src/ports.js";
import { ReleaseExecutor, type ReleaseExecutorOptions } from "../src/executor.js";
import type { ReleaseAuthorizer } from "../src/authorization.js";

export const RUN_ID = "run-a";
export const EPISODE_ID = "show:example-show:episode:episode-a";
export const BUNDLE_ID = "bundle-a";
export const DESTINATION_A = "destination-a";
export const DESTINATION_B = "destination-b";

/** Authorities the release gates grant (contract §13.4). */
export const UPLOAD_AUTHORITY = "release.upload";
export const PUBLISH_AUTHORITY = "release.publish";

export const OPERATOR: ActorRef = { kind: "human", id: "operator-a", displayName: "Operator A" };

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

/**
 * A bundle shaped like contract §17's example: media first, then a visibility transition, with
 * a thumbnail and a notification as post-upload best-effort work.
 */
export function aBundle(overrides: Partial<ReleaseBundle> = {}): ReleaseBundle {
  return {
    bundleId: BUNDLE_ID,
    runId: RUN_ID,
    episodeId: EPISODE_ID,
    required: [
      requiredOperation({
        operationId: "upload-media",
        kind: "media.upload",
        destination: DESTINATION_A,
        inputHashes: [DIGEST_A],
        requiresAuthority: UPLOAD_AUTHORITY,
      }),
      requiredOperation({
        operationId: "make-public",
        kind: "visibility.transition",
        destination: DESTINATION_A,
        inputHashes: [DIGEST_A],
        requiresAuthority: PUBLISH_AUTHORITY,
      }),
    ],
    bestEffort: [
      bestEffortOperation({
        operationId: "set-thumbnail",
        kind: "thumbnail.set",
        destination: DESTINATION_A,
        inputHashes: [DIGEST_B],
      }),
      bestEffortOperation({
        operationId: "notify",
        kind: "notification.send",
        destination: DESTINATION_B,
        inputHashes: [],
      }),
    ],
    ...overrides,
  };
}

/** A bundle with a single required operation, for tests that need no ceremony. */
export function aMinimalBundle(overrides: Partial<ReleaseBundle> = {}): ReleaseBundle {
  return {
    bundleId: BUNDLE_ID,
    runId: RUN_ID,
    episodeId: EPISODE_ID,
    required: [
      requiredOperation({
        operationId: "upload-media",
        kind: "media.upload",
        destination: DESTINATION_A,
        inputHashes: [DIGEST_A],
      }),
    ],
    bestEffort: [],
    ...overrides,
  };
}

/** An authorizer that holds exactly the listed authorities. */
export function authorizerHolding(...authorities: string[]): ReleaseAuthorizer {
  const held = new Set(authorities);
  return {
    check: (_runId, authority) =>
      Promise.resolve(
        held.has(authority)
          ? { authorized: true, gateId: `gate-for-${authority}` }
          : {
              authorized: false,
              explanation: `No approved gate grants "${authority}".`,
            },
      ),
  };
}

/** The pieces of a wired executor a test may want to inspect. */
export interface Harness {
  executor: ReleaseExecutor;
  adapters: AdapterRegistry;
  a: RecordingReleaseAdapter;
  b: RecordingReleaseAdapter;
  receipts: MemoryReleaseReceiptStore;
  events: MemoryReleaseEventSink;
}

/** Build an executor with recording adapters and deterministic ids. */
export function makeHarness(
  options: {
    a?: RecordingAdapterOptions;
    b?: RecordingAdapterOptions;
    authorizer?: ReleaseAuthorizer;
    receipts?: ReleaseReceiptStore;
  } = {},
): Harness {
  const a = new RecordingReleaseAdapter(DESTINATION_A, options.a ?? {});
  const b = new RecordingReleaseAdapter(DESTINATION_B, options.b ?? {});
  const adapters = new AdapterRegistry([a, b]);
  const receipts = new MemoryReleaseReceiptStore();
  const events = new MemoryReleaseEventSink();

  let releaseCounter = 0;
  let eventCounter = 0;
  const executorOptions: ReleaseExecutorOptions = {
    adapters,
    receipts: options.receipts ?? receipts,
    events,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    nextReleaseId: () => `rel-${(releaseCounter += 1)}`,
    nextEventId: () => `evt-${(eventCounter += 1)}`,
    ...(options.authorizer === undefined ? {} : { authorizer: options.authorizer }),
  };

  return { executor: new ReleaseExecutor(executorOptions), adapters, a, b, receipts, events };
}
