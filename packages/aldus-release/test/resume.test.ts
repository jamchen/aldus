/**
 * Resumption and partial success (architecture contract §17, §19.1).
 *
 * §19.1 requires recovery from partial success; §17 requires each operation to be independently
 * resumable. A release that failed halfway must be completable without redoing the half that
 * worked — both because repeating a publish is harmful, and because an operator who cannot
 * resume will reach for a fresh bundle and publish twice by hand.
 *
 * Bundle state is derived from receipts on every call, never stored. A stored "in progress" flag
 * outlives the crash that interrupted the work it describes, and an operator then reads a status
 * that was true once and is not true now.
 */

import { describe, expect, it } from "vitest";

import {
  aBundle,
  authorizerHolding,
  makeHarness,
  OPERATOR,
  PUBLISH_AUTHORITY,
  RUN_ID,
  UPLOAD_AUTHORITY,
} from "./helpers.js";

function harness(options: Parameters<typeof makeHarness>[0] = {}) {
  return makeHarness({
    authorizer: authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY),
    ...options,
  });
}

describe("resuming a half-executed bundle", () => {
  it("does not redo the operations that already succeeded", async () => {
    const { executor, a, b } = harness({
      a: { outcomes: { "make-public": { status: "failed", message: "temporarily rejected" } } },
    });
    const bundle = aBundle();

    const first = await executor.execute(bundle, { actor: OPERATOR });
    expect(first.state).toBe("failed");
    expect(a.executionCount("upload-media")).toBe(1);

    const second = await executor.execute(bundle, { actor: OPERATOR });

    // The upload was not repeated; only the operation that failed was retried.
    expect(a.executionCount("upload-media")).toBe(1);
    expect(a.executionCount("make-public")).toBe(2);
    expect(second.state).toBe("failed");
    expect(b.executed).toEqual([]);
  });

  it("completes once the failing operation succeeds", async () => {
    let failNext = true;
    const { executor, a, adapters } = harness();
    // Replace the scripted adapter with one that fails once, then succeeds — a transient
    // destination error, which is the ordinary case resumption exists for.
    adapters.register({
      destination: a.destination,
      execute: (request) => {
        a.executed.push(request);
        if (request.operation.operationId === "make-public" && failNext) {
          failNext = false;
          return Promise.resolve({ status: "failed" as const, message: "temporarily rejected" });
        }
        a.remote.set(request.idempotencyKey, { exists: true, remoteId: "remote" });
        return Promise.resolve({ status: "succeeded" as const, remoteId: "remote" });
      },
      lookup: (request) =>
        Promise.resolve(a.remote.get(request.idempotencyKey) ?? { exists: false }),
    });
    const bundle = aBundle();

    expect((await executor.execute(bundle, { actor: OPERATOR })).state).toBe("failed");
    const outcome = await executor.execute(bundle, { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(a.executionCount("upload-media")).toBe(1);
  });

  it("writes nothing when every operation is already done", async () => {
    const { executor } = harness();
    const bundle = aBundle();
    await executor.execute(bundle, { actor: OPERATOR });

    const second = await executor.execute(bundle, { actor: OPERATOR });

    expect(second.written).toEqual([]);
    expect(second.state).toBe("succeeded");
  });
});

describe("derived status (§19.1)", () => {
  it("reports a bundle nobody has run as not started", async () => {
    const { executor } = harness();
    const status = await executor.status(aBundle());

    expect(status.state).toBe("not_started");
    expect(status.operations.every((entry) => entry.state === "not_started")).toBe(true);
    expect(status.remaining).toEqual(["upload-media", "make-public", "set-thumbnail", "notify"]);
  });

  it("names exactly what is left after a partial failure", async () => {
    const { executor } = harness({
      a: { outcomes: { "make-public": { status: "failed", message: "rejected" } } },
    });
    const bundle = aBundle();
    await executor.execute(bundle, { actor: OPERATOR });

    const status = await executor.status(bundle);

    expect(status.state).toBe("failed");
    // An operator can read this and know precisely what still has to happen.
    expect(status.remaining).toEqual(["make-public", "set-thumbnail", "notify"]);
    expect(status.operations[0]).toMatchObject({
      operationId: "upload-media",
      state: "succeeded",
    });
  });

  it("reports succeeded when only best-effort work is outstanding", async () => {
    const { executor } = harness({
      a: { outcomes: { "set-thumbnail": { status: "failed", message: "rejected" } } },
    });
    const bundle = aBundle();
    await executor.execute(bundle, { actor: OPERATOR });

    const status = await executor.status(bundle);

    // §17's distinction, read back: the release is done even though optional work is not.
    expect(status.state).toBe("succeeded");
    expect(status.remaining).toContain("set-thumbnail");
  });

  it("attaches the receipt each state was derived from", async () => {
    const { executor } = harness();
    const bundle = aBundle();
    await executor.execute(bundle, { actor: OPERATOR });

    const status = await executor.status(bundle);
    expect(status.operations[0]?.receipt).toMatchObject({
      runId: RUN_ID,
      status: "succeeded",
      operation: "media.upload",
    });
  });

  it("resolves to the latest receipt when an operation was retried", async () => {
    let failNext = true;
    const { executor, a, adapters } = harness();
    adapters.register({
      destination: a.destination,
      execute: (request) => {
        a.executed.push(request);
        if (failNext) {
          failNext = false;
          return Promise.resolve({ status: "failed" as const, message: "transient" });
        }
        a.remote.set(request.idempotencyKey, { exists: true });
        return Promise.resolve({ status: "succeeded" as const });
      },
      lookup: (request) =>
        Promise.resolve(a.remote.get(request.idempotencyKey) ?? { exists: false }),
    });
    const bundle = aBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    await executor.execute(bundle, { actor: OPERATOR });

    // A retry appends a receipt rather than editing the failure, and the later one wins —
    // otherwise the record would lose the fact that the first attempt failed.
    const status = await executor.status(bundle);
    expect(status.operations[0]?.state).toBe("succeeded");
  });

  it("is read-only, so inspecting a bundle never advances it", async () => {
    const { executor, a } = harness();
    const bundle = aBundle();

    await executor.status(bundle);
    await executor.status(bundle);

    expect(a.executed).toEqual([]);
  });
});
