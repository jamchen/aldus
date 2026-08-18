/**
 * Required versus best-effort (architecture contract §17).
 *
 * §17: "Pre-release hard gates and post-upload best-effort operations MUST be distinguished."
 *
 * The distinction has two halves, and both matter. A failed thumbnail must not fail a release
 * that succeeded — otherwise an operator retries a publish that already happened. And a failed
 * media upload must fail the release outright, and must stop the operations that follow it: a
 * visibility transition after a failed upload makes nothing public while reporting that it did.
 */

import { describe, expect, it } from "vitest";

import { assertBundleValid } from "../src/bundle.js";
import { ReleaseErrorCodes } from "../src/errors.js";
import { bestEffortOperation, requiredOperation } from "../src/operation.js";
import {
  aBundle,
  aMinimalBundle,
  authorizerHolding,
  BUNDLE_ID,
  DESTINATION_A,
  EPISODE_ID,
  makeHarness,
  OPERATOR,
  PUBLISH_AUTHORITY,
  RUN_ID,
  UPLOAD_AUTHORITY,
} from "./helpers.js";

/** The standard bundle needs both release authorities. */
function harness(options: Parameters<typeof makeHarness>[0] = {}) {
  return makeHarness({
    authorizer: authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY),
    ...options,
  });
}

describe("required operations", () => {
  it("run in declaration order", async () => {
    const { executor, a } = harness();
    await executor.execute(aBundle(), { actor: OPERATOR });

    expect(a.executed.map((request) => request.operation.operationId)).toEqual([
      "upload-media",
      "make-public",
      "set-thumbnail",
    ]);
  });

  it("stop the bundle at the first failure", async () => {
    const { executor, a, b } = harness({
      a: { outcomes: { "upload-media": { status: "failed", message: "destination rejected it" } } },
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.state).toBe("failed");
    // Making something public after its media failed to upload would publish nothing while
    // reporting a release.
    expect(a.executionCount("make-public")).toBe(0);
    expect(b.executed).toEqual([]);
  });

  it("stop the bundle when an outcome is unconfirmed", async () => {
    const { executor, a } = harness({
      a: { outcomes: { "upload-media": { status: "pending" } } },
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.state).toBe("pending");
    expect(a.executionCount("make-public")).toBe(0);
  });

  it("record the failure as a receipt with a structured error", async () => {
    const { executor, receipts } = harness({
      a: { outcomes: { "upload-media": { status: "failed", message: "destination rejected it" } } },
    });

    await executor.execute(aBundle(), { actor: OPERATOR });
    const stored = await receipts.list(RUN_ID);

    expect(stored[0]).toMatchObject({ status: "failed" });
    expect(stored[0]?.error).toMatchObject({
      code: "ALDUS_RELEASE_OPERATION_FAILED",
      category: "provider",
      message: "destination rejected it",
    });
  });

  it("leave no completion time on an unconfirmed receipt", async () => {
    // `pending` is not terminal, and a completion time on it would claim otherwise.
    const { executor, receipts } = harness({
      a: { outcomes: { "upload-media": { status: "pending" } } },
    });

    await executor.execute(aBundle(), { actor: OPERATOR });
    const stored = await receipts.list(RUN_ID);

    expect(stored[0]?.status).toBe("pending");
    expect(stored[0]?.completedAt).toBeUndefined();
  });
});

describe("best-effort operations", () => {
  it("do not fail the release when they fail", async () => {
    const { executor } = harness({
      a: { outcomes: { "set-thumbnail": { status: "failed", message: "rejected" } } },
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(outcome.warnings.some((note) => note.includes("set-thumbnail"))).toBe(true);
  });

  it("keep running after one of them fails", async () => {
    const { executor, b } = harness({
      a: { outcomes: { "set-thumbnail": { status: "failed", message: "rejected" } } },
    });

    await executor.execute(aBundle(), { actor: OPERATOR });

    // The notification still went out. One optional operation failing does not cancel another.
    expect(b.executionCount("notify")).toBe(1);
  });

  it("are not attempted when a required operation failed", async () => {
    const { executor, a, b } = harness({
      a: { outcomes: { "upload-media": { status: "failed", message: "rejected" } } },
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    // §17 calls them post-upload. Announcing a release that did not happen is worse than not
    // announcing one that did.
    expect(a.executionCount("set-thumbnail")).toBe(0);
    expect(b.executed).toEqual([]);
    expect(outcome.warnings.some((note) => note.includes("not attempted"))).toBe(true);
  });

  it("still record a receipt when they fail, so the failure is visible", async () => {
    const { executor, receipts } = harness({
      a: { outcomes: { "set-thumbnail": { status: "failed", message: "rejected" } } },
    });

    await executor.execute(aBundle(), { actor: OPERATOR });
    const stored = await receipts.list(RUN_ID);

    expect(stored.find((receipt) => receipt.operation === "thumbnail.set")).toMatchObject({
      status: "failed",
    });
  });
});

describe("the required/best-effort distinction is structural", () => {
  it("keeps the two categories in separate lists rather than in a field", () => {
    // A `criticality` field would be set at a call site far from where the consequence lands,
    // and setting it wrongly turns a failed upload into a successful release. Placement in one
    // list or the other makes that mistake a type error instead.
    const bundle = aBundle();
    expect(bundle.required.map((operation) => operation.operationId)).toEqual([
      "upload-media",
      "make-public",
    ]);
    expect(bundle.bestEffort.map((operation) => operation.operationId)).toEqual([
      "set-thumbnail",
      "notify",
    ]);
  });

  it("refuses to put a best-effort operation in the required list", () => {
    const best = bestEffortOperation({
      operationId: "notify",
      kind: "notification.send",
      destination: DESTINATION_A,
      inputHashes: [],
    });
    // @ts-expect-error a BestEffortOperation is not assignable to the required list
    const invalid: (typeof bundle)["required"] = [best];
    const bundle = aMinimalBundle();
    expect(invalid).toHaveLength(1);
  });

  it("refuses to put a required operation in the best-effort list", () => {
    const required = requiredOperation({
      operationId: "upload-media",
      kind: "media.upload",
      destination: DESTINATION_A,
      inputHashes: [],
    });
    // @ts-expect-error a RequiredOperation is not assignable to the best-effort list
    const invalid: (typeof bundle)["bestEffort"] = [required];
    const bundle = aMinimalBundle();
    expect(invalid).toHaveLength(1);
  });

  it("reports each operation's category in the derived status", async () => {
    const { executor } = harness();
    const status = await executor.status(aBundle());

    expect(status.operations.map((entry) => entry.criticality)).toEqual([
      "required",
      "required",
      "best_effort",
      "best_effort",
    ]);
  });
});

describe("bundle validation", () => {
  it("refuses a bundle with no operations", () => {
    expect(() =>
      assertBundleValid({
        bundleId: BUNDLE_ID,
        runId: RUN_ID,
        episodeId: EPISODE_ID,
        required: [],
        bestEffort: [],
      }),
    ).toThrowError(
      expect.objectContaining({ code: ReleaseErrorCodes.EMPTY_BUNDLE }) as unknown as Error,
    );
  });

  it("refuses a repeated operation id, across both lists", () => {
    const bundle = aMinimalBundle({
      bestEffort: [
        bestEffortOperation({
          operationId: "upload-media",
          kind: "notification.send",
          destination: DESTINATION_A,
          inputHashes: [],
        }),
      ],
    });
    // Ids match receipts back to operations; a duplicate lets one inherit the other's outcome.
    expect(() => assertBundleValid(bundle)).toThrowError(
      expect.objectContaining({ code: ReleaseErrorCodes.DUPLICATE_OPERATION }) as unknown as Error,
    );
  });

  it("refuses an operation whose destination has no adapter", async () => {
    const { executor } = harness();
    const bundle = aMinimalBundle({
      required: [
        requiredOperation({
          operationId: "upload-media",
          kind: "media.upload",
          destination: "destination-unregistered",
          inputHashes: [],
        }),
      ],
    });

    // Skipping it would report a complete release that never touched the destination.
    await expect(executor.execute(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.ADAPTER_NOT_REGISTERED,
    });
  });
});

describe("events (§6.4)", () => {
  it("emits one per recorded outcome", async () => {
    const { executor, events } = harness();
    await executor.execute(aBundle(), { actor: OPERATOR });

    expect(events.events).toHaveLength(4);
    expect(events.events.map((event) => event.action)).toEqual([
      "release.operation.succeeded",
      "release.operation.succeeded",
      "release.operation.succeeded",
      "release.operation.succeeded",
    ]);
  });

  it("carries the idempotency key and the operation identity", async () => {
    const { executor, events, receipts } = harness();
    await executor.execute(aMinimalBundle(), { actor: OPERATOR });

    const stored = await receipts.list(RUN_ID);
    expect(events.events[0]).toMatchObject({
      runId: RUN_ID,
      episodeId: EPISODE_ID,
      idempotencyKey: stored[0]?.idempotencyKey,
    });
    expect(events.events[0]?.details).toMatchObject({
      bundleId: BUNDLE_ID,
      operationId: "upload-media",
      destination: DESTINATION_A,
    });
  });

  it("carries the failure onto the event, not just the receipt", async () => {
    const { executor, events } = harness({
      a: { outcomes: { "upload-media": { status: "failed", message: "rejected" } } },
    });
    await executor.execute(aMinimalBundle(), { actor: OPERATOR });

    expect(events.events[0]?.action).toBe("release.operation.failed");
    expect(events.events[0]?.error).toMatchObject({ message: "rejected" });
  });
});

describe("actor identity on emitted events (§19.2)", () => {
  // §19.2: "Mutating actions MUST record actor identity." A release operation is about as
  // mutating as this system gets, and §20 must be able to answer "who or what performed it".
  // An event attributed to the executor itself answers that question with the name of the
  // machinery rather than the name of whoever decided to publish.
  it("records the caller's actor on every emitted event, not the executor", async () => {
    const harness = makeHarness();
    const bundle = aMinimalBundle();

    await harness.executor.execute(bundle, { actor: OPERATOR });

    expect(harness.events.events.length).toBeGreaterThan(0);
    for (const event of harness.events.events) {
      expect(event.actor).toEqual(OPERATOR);
    }
  });

  it("records the caller's actor on a reconciliation repair too", async () => {
    // Reconciliation writes receipts, so it is a mutation and carries the same obligation.
    const harness = makeHarness();
    const bundle = aMinimalBundle();

    await harness.executor.execute(bundle, { actor: OPERATOR });
    harness.receipts.forget(RUN_ID);
    harness.events.events.length = 0;

    await harness.executor.reconcile(bundle, { actor: OPERATOR });

    expect(harness.events.events.length).toBeGreaterThan(0);
    for (const event of harness.events.events) {
      expect(event.actor).toEqual(OPERATOR);
      expect(event.actor.kind).not.toBe("system");
    }
  });
});
