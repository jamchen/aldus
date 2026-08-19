/**
 * The double publish.
 *
 * Contract §17 requires each release operation to be "independently idempotent and resumable",
 * and requires external-state reconciliation. §1.1 names "unsafe all-or-nothing publish
 * operations" among the things V1 must reduce.
 *
 * The failure underneath all of that is specific: a destination accepts a request, the response
 * is lost, and the local record says nothing happened. Retrying then publishes twice — and for a
 * public release, the second publish is not something an operator can quietly undo.
 *
 * This file reproduces that duplicate first, so the tests below prove a prevention rather than
 * assert an invariant, and then shows each mechanism that makes it impossible.
 */

import { describe, expect, it } from "vitest";

import { deriveIdempotencyKey } from "../src/bundle.js";
import { ReleaseErrorCodes } from "../src/errors.js";
import { aMinimalBundle, makeHarness, OPERATOR, RUN_ID, DESTINATION_A } from "./helpers.js";

describe("the failure this package prevents", () => {
  it("reproduces the duplicate publish that happens when a lost receipt is retried blindly", async () => {
    const { executor, a, receipts } = makeHarness();
    const bundle = aMinimalBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    expect(a.executionCount("upload-media")).toBe(1);

    // The response was recorded, then lost — a crash before the receipt reached disk, a restored
    // workspace, a `release.json` that never survived. The destination still holds the upload.
    receipts.forget(RUN_ID);

    // A blind retry: exactly what `reconcile: false` models.
    await executor.execute(bundle, { actor: OPERATOR, reconcile: false });

    // Published twice. Nothing reported a problem.
    expect(a.executionCount("upload-media")).toBe(2);
  });

  it("does not repeat the operation when reconciliation runs first", async () => {
    const { executor, a, receipts } = makeHarness();
    const bundle = aMinimalBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    expect(a.executionCount("upload-media")).toBe(1);

    receipts.forget(RUN_ID);
    const lookupsBefore = a.lookedUp.length;

    const outcome = await executor.execute(bundle, { actor: OPERATOR });

    // The destination was asked, not told.
    expect(a.executionCount("upload-media")).toBe(1);
    expect(a.lookedUp.length).toBeGreaterThan(lookupsBefore);
    expect(outcome.state).toBe("succeeded");
  });

  it("repairs the local record from what the destination holds", async () => {
    const { executor, a, receipts } = makeHarness();
    const bundle = aMinimalBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    receipts.forget(RUN_ID);

    const report = await executor.reconcile(bundle, { actor: OPERATOR });

    expect(report.repaired).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      operationId: "upload-media",
      action: "repaired",
    });
    expect(report.repaired[0]).toMatchObject({
      status: "succeeded",
      remoteId: "remote-upload-media",
      runId: RUN_ID,
    });
    expect(a.executionCount("upload-media")).toBe(1);
  });
});

describe("reconciliation", () => {
  it("leaves an operation alone when the destination does not hold it", async () => {
    const { executor } = makeHarness();
    const report = await executor.reconcile(aMinimalBundle(), { actor: OPERATOR });

    expect(report.repaired).toEqual([]);
    expect(report.findings[0]?.action).toBe("confirmed_absent");
  });

  it("does not re-query an operation whose outcome is already recorded", async () => {
    const { executor, a } = makeHarness();
    const bundle = aMinimalBundle();
    await executor.execute(bundle, { actor: OPERATOR });
    const before = a.lookedUp.length;

    const report = await executor.reconcile(bundle, { actor: OPERATOR });

    // Asking again about a settled operation turns reconciliation into polling.
    expect(a.lookedUp).toHaveLength(before);
    expect(report.findings[0]?.action).toBe("already_recorded");
  });

  it("reports that a destination cannot be queried rather than assuming", async () => {
    const { executor } = makeHarness({ a: { withoutLookup: true } });
    const report = await executor.reconcile(aMinimalBundle(), { actor: OPERATOR });

    expect(report.findings[0]).toMatchObject({ action: "unavailable" });
    expect(report.findings[0]?.explanation).toContain("cannot be queried");
  });

  it("refuses to retry an unconfirmed operation it cannot reconcile", async () => {
    // The dangerous combination: an outcome we never confirmed, and no way to ask. §17 says
    // resumable "where the platform allows it"; where it does not, refusing beats guessing.
    const { executor } = makeHarness({
      a: { withoutLookup: true, outcomes: { "upload-media": { status: "pending" } } },
    });
    const bundle = aMinimalBundle();

    await executor.execute(bundle, { actor: OPERATOR });

    await expect(executor.execute(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RECONCILIATION_UNAVAILABLE,
    });
  });

  it("resolves a pending operation once the destination confirms it", async () => {
    const { executor, a } = makeHarness({
      a: { outcomes: { "upload-media": { status: "pending" } } },
    });
    const bundle = aMinimalBundle();

    const first = await executor.execute(bundle, { actor: OPERATOR });
    expect(first.state).toBe("pending");

    // The destination finished processing after the fact, as an asynchronous platform would.
    const key = deriveIdempotencyKey(bundle.required[0]!);
    a.remote.set(key, { exists: true, remoteId: "remote-late" });

    const second = await executor.execute(bundle, { actor: OPERATOR });

    expect(second.state).toBe("succeeded");
    expect(a.executionCount("upload-media")).toBe(1);
  });

  it("refuses to reconcile against a destination that has no adapter", async () => {
    const { executor } = makeHarness();
    const bundle = aMinimalBundle({
      required: aMinimalBundle().required.map((operation) => ({
        ...operation,
        destination: "destination-unregistered",
      })) as typeof bundle.required,
    });

    await expect(executor.reconcile(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.ADAPTER_NOT_REGISTERED,
    });
  });
});

describe("idempotency keys", () => {
  it("are stable across executions, so a resumed bundle recognises its own work", () => {
    const bundle = aMinimalBundle();
    const first = deriveIdempotencyKey(bundle.required[0]!);
    const second = deriveIdempotencyKey(bundle.required[0]!);
    expect(first).toBe(second);
  });

  it("change when what is released changes", () => {
    const bundle = aMinimalBundle();
    const original = deriveIdempotencyKey(bundle.required[0]!);
    const edited = deriveIdempotencyKey({
      ...bundle.required[0]!,
      inputHashes: ["c".repeat(64)],
    });
    // Otherwise a re-cut render would inherit the previous render's receipt and be skipped.
    expect(edited).not.toBe(original);
  });

  it("ignore the order input hashes were listed in", () => {
    const bundle = aMinimalBundle();
    const one = deriveIdempotencyKey({
      ...bundle.required[0]!,
      inputHashes: ["a".repeat(64), "b".repeat(64)],
    });
    const other = deriveIdempotencyKey({
      ...bundle.required[0]!,
      inputHashes: ["b".repeat(64), "a".repeat(64)],
    });
    expect(one).toBe(other);
  });

  it("differ between destinations", () => {
    const bundle = aMinimalBundle();
    const here = deriveIdempotencyKey(bundle.required[0]!);
    const there = deriveIdempotencyKey({
      ...bundle.required[0]!,
      destination: "destination-b",
    });
    expect(here).not.toBe(there);
    expect(bundle.required[0]?.destination).toBe(DESTINATION_A);
  });

  it("reach the adapter, so a platform can deduplicate remotely too", async () => {
    const { executor, a } = makeHarness();
    const bundle = aMinimalBundle();
    await executor.execute(bundle, { actor: OPERATOR });

    expect(a.executed[0]?.idempotencyKey).toBe(deriveIdempotencyKey(bundle.required[0]!));
  });
});
