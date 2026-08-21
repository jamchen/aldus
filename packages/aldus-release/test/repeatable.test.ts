/**
 * An operation that may safely be performed again (#169, ADR-0048).
 *
 * The adopter's case, from `megaphone-aldus`: an upload publishes a temporary marker and a
 * best-effort cleanup removes it once the receipt is durable. The cleanup **cannot** answer
 * `lookup`, and not because answering is expensive:
 *
 * - reconciliation runs before execution, so when the cleanup is asked, the upload in the same
 *   bundle may not have happened yet — the marker's absence then means "nothing is published",
 *   not "the marker was removed", and a `succeeded` receipt written from that reading would
 *   strand the marker on a published video permanently;
 * - a throw from any operation's `lookup` aborts the whole pass before a single `execute`, so an
 *   honest failure while asking about a tidy-up blocks the upload.
 *
 * Their adapter therefore returned `{ exists: false }` without reading the channel, and the
 * executor recorded `confirmed_absent` — a durable statement that a search was performed and
 * found nothing, when nothing was read. That is the defect this closes, and it is closed by
 * removing the question rather than by letting the answer be qualified.
 */

import { describe, expect, it } from "vitest";

import { ReleaseErrorCodes } from "../src/errors.js";
import { bestEffortOperation, repeatable } from "../src/operation.js";
import { aMinimalBundle, makeHarness, OPERATOR, DESTINATION_A, RUN_ID } from "./helpers.js";

/** The adopter's shape: an upload, then a best-effort cleanup declared safe to repeat. */
function bundleWithCleanup() {
  return aMinimalBundle({
    bestEffort: [
      bestEffortOperation({
        operationId: "marker-remove",
        kind: "marker.remove",
        destination: DESTINATION_A,
        inputHashes: [],
        repeatable: repeatable(
          "removing a marker that is not there removes nothing, so a redundant attempt costs one " +
            "idempotent search",
        ),
      }),
    ],
  });
}

describe("a declaration that repeating the effect is safe", () => {
  it("refuses a declaration that does not say why", () => {
    // It licenses performing a real external effect more than once. A bare flag is not something
    // an approver can accept or an operator can audit.
    expect(() => repeatable("   ")).toThrow(/must say why/);
  });

  it("cannot be assembled as an object literal", () => {
    // The brand, checked the way `RequiredOperation`'s is. A shape a caller can write is a shape
    // that gets written from configuration by someone who has not thought about it.
    const smuggled = { reason: "because I said so" } as unknown;
    // @ts-expect-error a repeatable declaration is minted, never assembled
    const rejected: ReturnType<typeof repeatable> = smuggled;
    expect(rejected).toBeDefined();
  });
});

describe("reconciliation does not ask about a repeatable operation", () => {
  it("records why it was not asked, and never claims a search", async () => {
    const { executor } = makeHarness();
    const report = await executor.reconcile(bundleWithCleanup(), { actor: OPERATOR });

    const finding = report.findings.find((entry) => entry.operationId === "marker-remove");
    expect(finding?.action).toBe("not_reconciled_repeatable");
    // The declared reason travels into the record, so a reader sees the justification and not
    // only the outcome.
    expect(finding?.explanation).toContain("removes nothing");

    // And crucially not this: `confirmed_absent` is a completed search, and none happened.
    expect(finding?.action).not.toBe("confirmed_absent");
    // And no lookup happened at all — asserted through the finding rather than a counter the
    // double does not keep.
    expect(report.findings.filter((entry) => entry.action === "confirmed_absent")).toHaveLength(1);
  });

  it("still reconciles the operations that did not declare themselves repeatable", async () => {
    // The declaration is per operation. Declining to answer for one must not disable
    // reconciliation for the upload beside it, which is what an adapter-wide `lookup` opt-out did.
    const { executor } = makeHarness();
    const report = await executor.reconcile(bundleWithCleanup(), { actor: OPERATOR });

    const upload = report.findings.find((entry) => entry.operationId === "upload-media");
    expect(upload?.action).toBe("confirmed_absent");
  });
});

describe("an unconfirmed earlier outcome no longer blocks the bundle forever", () => {
  it("re-executes a repeatable operation whose receipt is pending", async () => {
    // The second site, and the one the adopter had to dodge by never returning `pending`. The
    // same operation whose *failure* `execute` treats as a warning could, by having gone
    // unanswered once, refuse every later release of the bundle.
    const { executor, a, receipts } = makeHarness({
      a: { outcomes: { "marker-remove": { status: "pending", message: "no response" } } },
    });
    const bundle = bundleWithCleanup();

    const first = await executor.execute(bundle, { actor: OPERATOR });
    expect(first.state).toBe("succeeded");
    expect((await receipts.list(RUN_ID)).some((receipt) => receipt.status === "pending")).toBe(
      true,
    );

    // Previously ALDUS_RELEASE_RECONCILIATION_UNAVAILABLE, permanently.
    const second = await executor.execute(bundle, { actor: OPERATOR });

    expect(second.state).toBe("succeeded");
    expect(a.executionCount("marker-remove")).toBe(2);
    expect(second.warnings.some((warning) => warning.includes("safe to repeat"))).toBe(true);
  });

  it("still refuses a pending receipt on an operation that made no such declaration", async () => {
    // Fail-closed stays where a mistake publishes twice. Only the declaration moves it.
    const { executor } = makeHarness({
      a: { outcomes: { "upload-media": { status: "pending", message: "no response" } } },
    });
    const bundle = aMinimalBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    await expect(executor.execute(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RECONCILIATION_UNAVAILABLE,
    });
  });
});

describe("the adopter's acceptance case", () => {
  it("runs the cleanup without any adapter having to invent an answer", async () => {
    const { executor, a } = makeHarness();
    const bundle = bundleWithCleanup();

    const outcome = await executor.execute(bundle, { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(a.executionCount("upload-media")).toBe(1);
    expect(a.executionCount("marker-remove")).toBe(1);
    // No `confirmed_absent` was written for an operation nobody searched for.
    const report = await executor.reconcile(bundle, { actor: OPERATOR });
    const cleanup = report.findings.find((entry) => entry.operationId === "marker-remove");
    expect(cleanup?.action).toBe("already_recorded");
  });
});
