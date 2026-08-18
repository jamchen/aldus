/**
 * Release bundles (architecture contract §17).
 *
 * A bundle is a **declaration**, not a record of what happened: contract §17 states that
 * "publishing is a domain, not a single command", and the bundle is the domain's unit of intent.
 * What happened lives in `ReleaseReceipt`s, one per operation, in the Run's `release.json`
 * (§7).
 *
 * There is deliberately no persisted bundle state. Execution state is derived from the receipts
 * on every inspection, for the same reason ADR-0009 derives gate state rather than storing it: a
 * stored "in progress" flag survives a crash that the operation it describes did not, and an
 * operator then reads a status that was true once and is not true now.
 */

import { createHash } from "node:crypto";

import { ReleaseErrorCodes, releaseError } from "./errors.js";
import type { BestEffortOperation, ReleaseOperation, RequiredOperation } from "./operation.js";

/**
 * A set of release operations for one Run.
 *
 * The two lists are the §17 distinction between pre-release hard gates and post-upload
 * best-effort work. Required operations run first, in order; best-effort operations run only
 * once every required one has succeeded, because §17 calls them "post-upload".
 */
export interface ReleaseBundle {
  /** Identity of this bundle. Part of every operation's idempotency key. */
  bundleId: string;
  /** Run this release belongs to (contract §6). */
  runId: string;
  /** Canonical Episode identity, for the emitted events (contract §6.4). */
  episodeId: string;
  /** Operations whose failure fails the release, in execution order. */
  required: readonly RequiredOperation[];
  /** Operations attempted after the required ones, whose failure is recorded but tolerated. */
  bestEffort: readonly BestEffortOperation[];
}

/** Every operation in a bundle, required first, in execution order. */
export function operationsOf(bundle: ReleaseBundle): readonly ReleaseOperation[] {
  return [...bundle.required, ...bundle.bestEffort];
}

/**
 * Check a bundle's internal consistency.
 *
 * @throws {AldusError} `ALDUS_RELEASE_EMPTY_BUNDLE` if it declares no operations.
 * @throws {AldusError} `ALDUS_RELEASE_DUPLICATE_OPERATION` if an `operationId` repeats.
 */
export function assertBundleValid(bundle: ReleaseBundle): void {
  const operations = operationsOf(bundle);
  if (operations.length === 0) {
    throw releaseError(
      ReleaseErrorCodes.EMPTY_BUNDLE,
      `Release bundle "${bundle.bundleId}" declares no operations, so executing it would report ` +
        "a successful release that published nothing.",
      { category: "validation", details: { bundleId: bundle.bundleId } },
    );
  }

  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) {
      throw releaseError(
        ReleaseErrorCodes.DUPLICATE_OPERATION,
        `Release bundle "${bundle.bundleId}" declares "${operation.operationId}" twice. ` +
          "Operation ids match receipts back to operations, so a duplicate would let one " +
          "operation inherit the other's outcome.",
        {
          category: "validation",
          details: { bundleId: bundle.bundleId, operationId: operation.operationId },
        },
      );
    }
    seen.add(operation.operationId);
  }
}

/**
 * Derive the idempotency key for one operation (contract §17, §19.1).
 *
 * §17 requires each operation to be "independently idempotent and resumable where the platform
 * allows it", and `ReleaseReceipt.idempotencyKey` is the mechanism. The key is **derived, not
 * supplied**, from the bundle, the operation, its destination, and the digests of what it
 * releases — so a resumed execution computes the identical key without having to remember one,
 * and a changed input produces a different key rather than silently reusing an old outcome.
 *
 * Input hashes are sorted before digesting: the set of things released is what matters, not the
 * order a caller happened to list them in.
 */
export function deriveIdempotencyKey(bundleId: string, operation: ReleaseOperation): string {
  const material = JSON.stringify({
    bundleId,
    operationId: operation.operationId,
    kind: operation.kind,
    destination: operation.destination,
    inputHashes: [...operation.inputHashes].sort(),
  });
  return createHash("sha256").update(material, "utf8").digest("hex");
}
