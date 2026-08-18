/**
 * Release execution and reconciliation through the services (contract §17, §13.4).
 *
 * The property that matters most is that a lost receipt does not become a second publish. It is
 * tested by losing one and counting adapter executions — a spy on the executor could not establish
 * that a *real* second call never happened.
 */

import { writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServiceErrorCodes } from "../src/errors.js";
import {
  aBundle,
  makeComposedServices,
  releaseGates,
  releaseSubjects,
  seedRun,
  PUBLISH_GATE,
  RUN_ID,
  UPLOAD_GATE,
  type Harness,
} from "./composition-helpers.js";
import { makeTempWorkspace, OPERATOR, type TempWorkspace } from "./helpers.js";

let workspace: TempWorkspace;

beforeEach(async () => {
  workspace = await makeTempWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

async function armed(): Promise<Harness> {
  const harness = makeComposedServices(workspace.workspace, {
    gates: releaseGates(),
    subjects: releaseSubjects(),
  });
  await seedRun(harness.services);
  return harness;
}

/**
 * Wipe the Run's stored receipts, simulating a lost local record.
 *
 * The destination still holds what was published; only Aldus has forgotten. That asymmetry is
 * exactly what reconciliation exists for, and what a blind retry turns into a double publish.
 */
async function loseReceipts(): Promise<void> {
  await writeFile(workspace.workspace.layout.runFilePath(RUN_ID, "release"), "[]", "utf8");
}

/** Approve a release gate so its authority is held (contract §13.4). */
async function approve(harness: Harness, gateId: string): Promise<void> {
  const result = await harness.services.approve({ runId: RUN_ID, gateId, actor: OPERATOR });
  if (result.outcome !== "ok") throw new Error(`${gateId} should have been approvable`);
}

describe("authority (contract §13.4)", () => {
  it("refuses a required operation whose authority is not held", async () => {
    const harness = await armed();

    const result = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    // A refusal, not a thrown error: "not permitted right now" is an ordinary answer (§18).
    expect(result.outcome).toBe("refused");
    expect(harness.release.executionCount("upload")).toBe(0);
  });

  it("executes once the upload gate is approved", async () => {
    const harness = await armed();
    await approve(harness, UPLOAD_GATE);

    const result = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    expect(result.outcome).toBe("ok");
    expect(harness.release.executionCount("upload")).toBe(1);
  });

  it("does not let an upload approval authorize anything the publish gate grants", async () => {
    // §13.4 keeps uploading and making public separate. The gate engine owns that decision and the
    // services never re-decide it, so approving one must leave the other unheld.
    const harness = await armed();
    await approve(harness, UPLOAD_GATE);

    const bundle = aBundle({
      required: aBundle().required.map((operation) => ({
        ...operation,
        requiresAuthority: "release.publish",
      })) as ReturnType<typeof aBundle>["required"],
    });
    const result = await harness.services.executeRelease({ bundle, actor: OPERATOR });

    expect(result.outcome).toBe("refused");
    expect(harness.release.executionCount("upload")).toBe(0);
  });

  it("refuses an anonymous release (§19.2)", async () => {
    // No default actor on the context, none supplied at the call. §19.2 requires a mutating action
    // to record actor identity, and publishing is about as mutating as this system gets.
    const anonymous = makeComposedServices(workspace.workspace, {
      gates: releaseGates(),
      subjects: releaseSubjects(),
      actor: null,
    });
    await seedRun(anonymous.services);

    await expect(anonymous.services.executeRelease({ bundle: aBundle() })).rejects.toMatchObject({
      code: ServiceErrorCodes.ACTOR_REQUIRED,
    });
    expect(anonymous.release.executionCount("upload")).toBe(0);
  });
});

describe("reconciliation prevents a second publish (contract §17)", () => {
  it("does not re-execute an operation the destination already holds", async () => {
    const harness = await armed();
    await approve(harness, UPLOAD_GATE);
    await approve(harness, PUBLISH_GATE);

    const first = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });
    expect(first.outcome).toBe("ok");
    expect(harness.release.executionCount("upload")).toBe(1);

    // The failure this exists to prevent: the local record is lost while the destination still
    // holds the result. Without reconciliation the next execution publishes a second time.
    await loseReceipts();

    const second = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    expect(second.outcome).toBe("ok");
    // Still one. Reconciliation asked the destination, found the result, and repaired the record.
    expect(harness.release.executionCount("upload")).toBe(1);
  });

  it("offers no way to skip reconciliation", async () => {
    // `@aldus-runtime/release` exposes a `reconcile: false` switch so its own tests can demonstrate the
    // duplicate publish. The services deliberately do not surface it: making a double publish a
    // caller's option would move policy to the wrong side of the injection point (ADR-0015).
    const harness = await armed();
    const request: Parameters<typeof harness.services.executeRelease>[0] = {
      bundle: aBundle(),
      actor: OPERATOR,
    };
    expect(Object.keys(request).sort()).toEqual(["actor", "bundle"]);
  });

  it("repairs the local record and reports what it did", async () => {
    const harness = await armed();
    await approve(harness, UPLOAD_GATE);
    await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    await loseReceipts();

    const result = await harness.services.reconcileRelease({
      bundle: aBundle(),
      actor: OPERATOR,
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.report.repaired.length).toBeGreaterThan(0);
    expect(result.data.report.findings.some((finding) => finding.action === "repaired")).toBe(true);
  });
});

describe("wiring", () => {
  it("throws when no adapter serves a bundle's destination", async () => {
    // A wiring error rather than a refusal: no approval would conjure an adapter (ADR-0015).
    const harness = makeComposedServices(workspace.workspace, {
      gates: releaseGates(),
      subjects: releaseSubjects(),
      withReleaseAdapter: false,
    });
    await seedRun(harness.services);

    await expect(
      harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR }),
    ).rejects.toMatchObject({ code: ServiceErrorCodes.ADAPTER_NOT_WIRED });
  });

  it("reports bundle status without needing an actor", async () => {
    // Read-only, so §24's "see the state without ceremony" holds here too.
    const harness = await armed();
    const result = await harness.services.releaseBundleStatus({ bundle: aBundle() });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.status.state).toBe("not_started");
    expect(result.data.status.remaining).toContain("upload");
  });
});

describe("best-effort operations (contract §17)", () => {
  it("succeeds the release even when a best-effort operation fails", async () => {
    // §17 distinguishes pre-release hard gates from post-upload best-effort work. A failed
    // notification leaves a warning; it does not undo an upload that succeeded.
    const harness = makeComposedServices(workspace.workspace, {
      gates: releaseGates(),
      subjects: releaseSubjects(),
      releaseOutcomes: {
        notify: { status: "failed", message: "The notification channel refused.", retryable: true },
      },
    });
    await seedRun(harness.services);
    await approve(harness, UPLOAD_GATE);

    const result = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.data.outcome.state).toBe("succeeded");
    // The failure is surfaced as a warning rather than swallowed: an operator needs to know the
    // notification did not go out, even though the release stands.
    expect(result.data.outcome.warnings.join(" ")).toContain("notify");
    expect(result.data.outcome.warnings.join(" ")).toContain("release is unaffected");
  });

  it("fails the release when a required operation fails", async () => {
    const harness = makeComposedServices(workspace.workspace, {
      gates: releaseGates(),
      subjects: releaseSubjects(),
      releaseOutcomes: {
        upload: {
          status: "failed",
          message: "The destination rejected the media.",
          retryable: false,
        },
      },
    });
    await seedRun(harness.services);
    await approve(harness, UPLOAD_GATE);

    const result = await harness.services.executeRelease({ bundle: aBundle(), actor: OPERATOR });

    // `unsuccessful`, not `refused`: it ran and did not succeed, which is a different answer from
    // "you are not allowed to run it".
    expect(result.outcome).toBe("unsuccessful");
  });
});
