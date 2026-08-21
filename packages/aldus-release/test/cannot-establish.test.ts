/**
 * An operation that is reconcilable in principle and cannot be established now (#169, ADR-0049).
 *
 * Mechanism one removed the question for an operation whose effect is safe to repeat. This is the
 * other half: an operation that genuinely needs reconciling, whose answer is unavailable *right
 * now* — a rate-limited destination, a privacy transition that leaves nothing on the channel
 * identifying it, a dropped connection.
 *
 * Before this the adapter had two options and both were wrong. Return `exists: false`, asserting a
 * completed search nobody performed. Or throw, aborting the whole reconciliation pass before a
 * single operation executed, so a quota error raised while asking about a tidy-up blocked the
 * upload beside it.
 *
 * The response is keyed on criticality, matching what `execute` already does with a best-effort
 * *failure*: unknown never licenses a publish, and it stops blocking a tidy-up.
 */

import { describe, expect, it } from "vitest";

import { cannotEstablish } from "../src/adapter.js";
import { ReleaseErrorCodes } from "../src/errors.js";
import { bestEffortOperation } from "../src/operation.js";
import { aMinimalBundle, makeHarness, OPERATOR, DESTINATION_A, RUN_ID } from "./helpers.js";
import { deriveIdempotencyKey } from "../src/bundle.js";

/** A bundle whose best-effort cleanup genuinely needs reconciling. */
function bundleWithCleanup() {
  return aMinimalBundle({
    bestEffort: [
      bestEffortOperation({
        operationId: "privacy-transition",
        kind: "visibility.transition",
        destination: DESTINATION_A,
        inputHashes: [],
      }),
    ],
  });
}

describe("the declaration itself", () => {
  it("requires a reason", () => {
    // A rate limit, a permission problem, and a destination that does not retain what identifies
    // the operation call for three different responses. An operator cannot tell them apart from
    // the absence of an answer.
    expect(() => cannotEstablish("  ")).toThrow(/must say why/);
    expect(() => cannotEstablish(42 as unknown as string)).toThrow(/must say why/);
  });

  it("is recognised by membership, and an assembled literal is refused rather than read as absent", async () => {
    // The brand is a phantom, so a narrowing that trusted it would trust a type assertion — the
    // argument #170 had to apply four times, and this is the fifth. An assembled
    // `{ reason: "..." }` is correctly not an issued state, and would then have reached
    // `!remote.exists` with `exists` undefined and been recorded as `confirmed_absent`: a
    // completed search asserted from a value that is not a remote state at all.
    const bundle = aMinimalBundle();
    const key = deriveIdempotencyKey(bundle.required[0]!);
    const { executor, a } = makeHarness({
      a: {
        remote: {
          [key]: { reason: "looks right" } as unknown as ReturnType<typeof cannotEstablish>,
        },
      },
    });

    await expect(executor.reconcile(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.OPERATION_INVALID,
    });
    expect(a.executionCount("upload-media")).toBe(0);
  });

  it("accepts a state the adapter really did produce", () => {
    // The row that gets through, per ADR-0048: a table of refusals is satisfied by a check that
    // refuses everything.
    expect(cannotEstablish("the destination is rate limited").reason).toBe(
      "the destination is rate limited",
    );
  });
});

describe("a best-effort operation whose state cannot be established", () => {
  function harnessWithUnknownCleanup() {
    const bundle = bundleWithCleanup();
    const key = deriveIdempotencyKey(bundle.bestEffort[0]!);
    return {
      bundle,
      ...makeHarness({
        a: { remote: { [key]: cannotEstablish("the channel does not retain the marker") } },
      }),
    };
  }

  it("is recorded as skipped and the release continues", async () => {
    const { executor, bundle, a } = harnessWithUnknownCleanup();

    const outcome = await executor.execute(bundle, { actor: OPERATOR });

    // The release succeeds — matching what `execute` already does with a best-effort *failure*.
    expect(outcome.state).toBe("succeeded");
    expect(a.executionCount("upload-media")).toBe(1);
    // Not attempted: an operation that may already have happened is not one to repeat on a guess.
    expect(a.executionCount("privacy-transition")).toBe(0);
  });

  it("tells the operator, because this is exactly what they need to see", async () => {
    const { executor, bundle } = harnessWithUnknownCleanup();

    const outcome = await executor.execute(bundle, { actor: OPERATOR });

    expect(outcome.warnings.some((warning) => warning.includes("could not be established"))).toBe(
      true,
    );
    expect(outcome.warnings.some((warning) => warning.includes("does not retain"))).toBe(true);
  });

  it("writes no receipt at all, because a transient failure is not a decision", async () => {
    // The first version wrote a `skipped` receipt, which is terminal in both directions —
    // `execute` skips it and `reconcile` treats it as already recorded. One momentary query
    // failure then permanently retired the operation for that bundle, and the record said
    // `skipped`: a decision, when what happened was an unanswered question.
    //
    // A durable record of a transient failure is the same defect as a durable record of a search
    // nobody performed.
    const { executor, bundle, receipts } = harnessWithUnknownCleanup();

    await executor.execute(bundle, { actor: OPERATOR });

    const stored = await receipts.list(RUN_ID);
    expect(stored.map((receipt) => receipt.status)).toEqual(["succeeded"]);
    expect(stored.some((receipt) => receipt.status === "skipped")).toBe(false);
  });

  it("does not report a receipt it never wrote", async () => {
    // `report.repaired` used to carry the `skipped` entry, so `execute` counted it as written.
    const { executor, bundle } = harnessWithUnknownCleanup();

    const report = await executor.reconcile(bundle, { actor: OPERATOR });

    expect(report.findings.some((finding) => finding.action === "cannot_establish")).toBe(true);
    expect(report.repaired).toEqual([]);
  });
});

describe("a required operation whose state cannot be established", () => {
  it("refuses before anything executes, because unknown must not license a publish", async () => {
    const bundle = aMinimalBundle();
    const key = deriveIdempotencyKey(bundle.required[0]!);
    const { executor, a } = makeHarness({
      a: { remote: { [key]: cannotEstablish("the destination is rate limited") } },
    });

    await expect(executor.execute(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RECONCILIATION_UNAVAILABLE,
    });
    // Executing might repeat it and skipping might drop it. Neither is a choice to make blind.
    expect(a.executionCount("upload-media")).toBe(0);
  });
});

describe("an unanticipated throw from lookup", () => {
  it("no longer aborts the pass when it comes from a best-effort operation", async () => {
    // The reported failure: a quota error raised while asking about a tidy-up blocked the upload
    // beside it, because `reconcile` awaited every `lookup` bare.
    const { executor, a } = makeHarness({
      a: { lookupThrowsFor: ["privacy-transition"] },
    });

    const outcome = await executor.execute(bundleWithCleanup(), { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(a.executionCount("upload-media")).toBe(1);
    expect(outcome.warnings.some((warning) => warning.includes("destination query failed"))).toBe(
      true,
    );
  });

  it("still aborts when it comes from a required operation", async () => {
    // Fail-closed stays where a mistake publishes twice.
    const { executor, a } = makeHarness({ a: { lookupThrowsFor: ["upload-media"] } });

    await expect(executor.execute(aMinimalBundle(), { actor: OPERATOR })).rejects.toThrow(
      /destination query failed/,
    );
    expect(a.executionCount("upload-media")).toBe(0);
  });
});

describe("a success that has something to say (#169 item 4)", () => {
  it("carries the note into the durable receipt", async () => {
    // `failed` has `message` and `pending` has `message?`; `succeeded` had nowhere to put a
    // sentence, so an adapter that removed nothing because there was nothing to remove had to
    // discard the only part an operator would have wanted.
    const { executor, receipts } = makeHarness({
      a: {
        outcomes: {
          "upload-media": {
            status: "succeeded",
            remoteId: "remote-1",
            note: "no marker was found, so nothing was removed",
          },
        },
      },
    });

    await executor.execute(aMinimalBundle(), { actor: OPERATOR });

    const stored = await receipts.list(RUN_ID);
    const receipt = stored.find((entry) => entry.status === "succeeded");
    expect(receipt?.note).toBe("no marker was found, so nothing was removed");
  });

  it("leaves the receipt without a note when the adapter had nothing to say", async () => {
    // The control: an optional field that is always present is not optional, and one that is
    // never present is not read.
    const { executor, receipts } = makeHarness();

    await executor.execute(aMinimalBundle(), { actor: OPERATOR });

    const stored = await receipts.list(RUN_ID);
    expect(stored.find((entry) => entry.status === "succeeded")?.note).toBeUndefined();
  });
});

describe("a query failure retires nothing", () => {
  /**
   * Two passes, because one pass cannot see this.
   *
   * The suite was green with a `skipped` receipt being written, and the defect only appears on the
   * pass after: `skipped` is terminal in both directions, so the operation was gone from that
   * bundle forever. At the destination that produced #169 quota exhaustion is routine, so a rate
   * limit while *asking about* a best-effort operation would silently drop it.
   */
  function bundleWithTransition() {
    return aMinimalBundle({
      bestEffort: [
        bestEffortOperation({
          operationId: "privacy-transition",
          kind: "visibility.transition",
          destination: DESTINATION_A,
          inputHashes: [],
        }),
      ],
    });
  }

  it("asks again on the next pass, and performs the operation then", async () => {
    const bundle = bundleWithTransition();
    const first = makeHarness({ a: { lookupThrowsFor: ["privacy-transition"] } });

    const pass1 = await first.executor.execute(bundle, { actor: OPERATOR });
    expect(pass1.state).toBe("succeeded");
    expect(first.a.executionCount("privacy-transition")).toBe(0);
    // Nothing durable was written about it, which is the whole fix.
    expect(
      (await first.receipts.list(RUN_ID)).some(
        (receipt) => receipt.operation === "visibility.transition",
      ),
    ).toBe(false);

    // Same bundle, same receipts, a destination that answers now.
    const second = makeHarness({ receipts: first.receipts });
    const pass2 = await second.executor.execute(bundle, { actor: OPERATOR });

    expect(pass2.state).toBe("succeeded");
    // Previously 0: the operation had been retired by a momentary failure.
    expect(second.a.executionCount("privacy-transition")).toBe(1);
  });

  it("does not repeat the operation if it turns out to have happened already", async () => {
    // The other half of the trap. Not performing during the unknown pass is what makes the retry
    // safe: had it executed on an unknown prior state, it might have repeated one that succeeded.
    const bundle = bundleWithTransition();
    const key = deriveIdempotencyKey(bundle.bestEffort[0]!);
    const first = makeHarness({ a: { lookupThrowsFor: ["privacy-transition"] } });

    await first.executor.execute(bundle, { actor: OPERATOR });
    expect(first.a.executionCount("privacy-transition")).toBe(0);

    // It had in fact happened; the destination can say so now.
    const second = makeHarness({
      receipts: first.receipts,
      a: { remote: { [key]: { exists: true, remoteId: "remote-x" } } },
    });
    const pass2 = await second.executor.execute(bundle, { actor: OPERATOR });

    expect(pass2.state).toBe("succeeded");
    expect(second.a.executionCount("privacy-transition")).toBe(0);
    // `first.receipts`, because `makeHarness` returns its own store even when one is injected —
    // the executor writes to the injected one.
    const repaired = await first.receipts.list(RUN_ID);
    expect(
      repaired.some(
        (receipt) =>
          receipt.operation === "visibility.transition" && receipt.status === "succeeded",
      ),
    ).toBe(true);
  });
});
