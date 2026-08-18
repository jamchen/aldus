/**
 * Release authority (architecture contract §13.4, §17, §18.1).
 *
 * §13.4 requires release approval to bind to the final render, captions, metadata, destination,
 * and visibility policy, and requires uploading and making public to be separate operations.
 * §18.1 requires mutating production operations to validate approvals and publishing to require
 * explicit scoped authority.
 *
 * This package decides none of that. `@aldus-runtime/gate-engine` does, and the tests at the bottom wire
 * the real engine to prove the executor consumes its verdict rather than re-deriving one.
 */

import { describe, expect, it } from "vitest";

import { SCHEMA_VERSION } from "@aldus-runtime/core";
import {
  GateEngine,
  GateRegistry,
  MemoryGateDecisionStore,
  MemoryGateEventSink,
  digestBytes,
  toSubjectHashes,
  type GateDefinition,
  type GateSubject,
} from "@aldus-runtime/gate-engine";

import { gateEngineAuthorizer } from "../src/authorization.js";
import { ReleaseErrorCodes } from "../src/errors.js";
import {
  aBundle,
  authorizerHolding,
  EPISODE_ID,
  makeHarness,
  OPERATOR,
  PUBLISH_AUTHORITY,
  RUN_ID,
  UPLOAD_AUTHORITY,
} from "./helpers.js";

describe("authority", () => {
  it("refuses a required operation nobody approved, rather than warning", async () => {
    const { executor, a } = makeHarness({ authorizer: authorizerHolding() });

    await expect(executor.execute(aBundle(), { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED,
    });
    // Nothing reached the destination. A warning that still publishes is not a gate.
    expect(a.executed).toEqual([]);
  });

  it("marks the refusal non-retryable, because retrying cannot grant authority", async () => {
    const { executor } = makeHarness({ authorizer: authorizerHolding() });
    let thrown: unknown;
    await executor.execute(aBundle(), { actor: OPERATOR }).catch((error: unknown) => {
      thrown = error;
    });
    expect(thrown).toMatchObject({ retryable: false, category: "policy" });
  });

  it("uploads with upload authority but still refuses to make public (§13.4)", async () => {
    const { executor, a } = makeHarness({ authorizer: authorizerHolding(UPLOAD_AUTHORITY) });

    await expect(executor.execute(aBundle(), { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED,
    });

    // The upload happened; the visibility transition did not. That separation is the point of
    // §13.4 — approving an upload must not be approval to publish.
    expect(a.executionCount("upload-media")).toBe(1);
    expect(a.executionCount("make-public")).toBe(0);
  });

  it("completes once both authorities are held", async () => {
    const { executor, a } = makeHarness({
      authorizer: authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY),
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(a.executionCount("make-public")).toBe(1);
  });

  it("skips an unauthorized best-effort operation instead of failing the release", async () => {
    // A best-effort operation that needs authority nobody granted is recorded as `skipped`, not
    // `failed`: it was never attempted, and a failure would claim the destination rejected it.
    const bundle = aBundle();
    const restricted = {
      ...bundle,
      bestEffort: bundle.bestEffort.map((operation) =>
        operation.operationId === "notify"
          ? { ...operation, requiresAuthority: "notify.send" }
          : operation,
      ) as typeof bundle.bestEffort,
    };
    const { executor, b, receipts } = makeHarness({
      authorizer: authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY),
    });

    const outcome = await executor.execute(restricted, { actor: OPERATOR });

    expect(outcome.state).toBe("succeeded");
    expect(b.executed).toEqual([]);
    const stored = await receipts.list(RUN_ID);
    expect(stored.find((receipt) => receipt.operation === "notification.send")?.status).toBe(
      "skipped",
    );
  });

  it("does not consult the authorizer for an operation already recorded as succeeded", async () => {
    const holding = authorizerHolding(UPLOAD_AUTHORITY, PUBLISH_AUTHORITY);
    let checks = 0;
    const counted = {
      check: (runId: string, authority: string) => {
        checks += 1;
        return holding.check(runId, authority);
      },
    };
    const { executor } = makeHarness({ authorizer: counted });
    const bundle = aBundle();

    await executor.execute(bundle, { actor: OPERATOR });
    const after = checks;
    await executor.execute(bundle, { actor: OPERATOR });

    // Resuming a completed bundle re-checks nothing, because it re-runs nothing.
    expect(checks).toBe(after);
  });
});

describe("wired to the real gate engine (§13.4)", () => {
  const RENDER = "render";
  const UPLOAD_GATE = "release-upload";
  const PUBLISH_GATE = "release-publish";

  function gates(): GateDefinition[] {
    return [
      {
        gateId: UPLOAD_GATE,
        level: "human_oracle",
        enforcement: "blocking",
        binds: [RENDER],
        grants: [UPLOAD_AUTHORITY],
        expiresOnChange: true,
      },
      {
        gateId: PUBLISH_GATE,
        level: "human_oracle",
        enforcement: "blocking",
        binds: [RENDER],
        dependsOn: [UPLOAD_GATE],
        grants: [PUBLISH_AUTHORITY],
        expiresOnChange: true,
      },
    ];
  }

  function subjects(render: string): Record<string, readonly GateSubject[]> {
    const bound: GateSubject[] = [{ key: RENDER, sha256: digestBytes(render) }];
    return { [UPLOAD_GATE]: bound, [PUBLISH_GATE]: bound };
  }

  function makeEngine() {
    return new GateEngine({
      registry: GateRegistry.from(gates()),
      decisions: new MemoryGateDecisionStore(),
      events: new MemoryGateEventSink(),
    });
  }

  async function approve(engine: GateEngine, gateId: string, render: string): Promise<void> {
    await engine.decide({
      runId: RUN_ID,
      gateId,
      decision: "approved",
      subjects: subjects(render)[gateId] ?? [],
      decidedBy: OPERATOR,
      decidedAt: "2026-01-01T00:00:00.000Z",
      episodeId: EPISODE_ID,
    });
  }

  it("refuses a release the engine has not approved", async () => {
    const engine = makeEngine();
    const { executor, a } = makeHarness({
      authorizer: gateEngineAuthorizer(engine, subjects("v1")),
    });

    await expect(executor.execute(aBundle(), { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED,
    });
    expect(a.executed).toEqual([]);
  });

  it("releases once the engine's gates are approved", async () => {
    const engine = makeEngine();
    await approve(engine, UPLOAD_GATE, "v1");
    await approve(engine, PUBLISH_GATE, "v1");
    const { executor } = makeHarness({
      authorizer: gateEngineAuthorizer(engine, subjects("v1")),
    });

    const outcome = await executor.execute(aBundle(), { actor: OPERATOR });
    expect(outcome.state).toBe("succeeded");
  });

  it("refuses when the render changed after approval, without re-deciding staleness itself", async () => {
    // The engine derives staleness from the bound digest (ADR-0009). This package asks and
    // obeys; it holds no opinion about what "stale" means.
    const engine = makeEngine();
    await approve(engine, UPLOAD_GATE, "v1");
    await approve(engine, PUBLISH_GATE, "v1");
    const { executor, a } = makeHarness({
      authorizer: gateEngineAuthorizer(engine, subjects("v2")),
    });

    await expect(executor.execute(aBundle(), { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED,
    });
    expect(a.executed).toEqual([]);
  });

  it("reads subjects afresh on every check, so drift between planning and release is caught", async () => {
    const engine = makeEngine();
    await approve(engine, UPLOAD_GATE, "v1");
    await approve(engine, PUBLISH_GATE, "v1");

    let render = "v1";
    const { executor, a } = makeHarness({
      authorizer: gateEngineAuthorizer(engine, () => subjects(render)),
    });

    // The bundle was assembled while the approval was valid; the render moved before publication.
    const bundle = aBundle();
    const authorizer = gateEngineAuthorizer(engine, () => subjects(render));
    expect((await authorizer.check(RUN_ID, UPLOAD_AUTHORITY)).authorized).toBe(true);
    render = "v2";

    await expect(executor.execute(bundle, { actor: OPERATOR })).rejects.toMatchObject({
      code: ReleaseErrorCodes.RELEASE_NOT_AUTHORIZED,
    });
    expect(a.executed).toEqual([]);
    expect(SCHEMA_VERSION).toBeTruthy();
  });

  it("carries the granting gate id through, for trace (§20)", async () => {
    const engine = makeEngine();
    await approve(engine, UPLOAD_GATE, "v1");
    const authorizer = gateEngineAuthorizer(engine, subjects("v1"));

    const verdict = await authorizer.check(RUN_ID, UPLOAD_AUTHORITY);
    expect(verdict).toMatchObject({ authorized: true, gateId: UPLOAD_GATE });
  });

  it("passes the engine's own explanation back, so an operator learns which gate blocked", async () => {
    const engine = makeEngine();
    const authorizer = gateEngineAuthorizer(engine, subjects("v1"));

    const verdict = await authorizer.check(RUN_ID, PUBLISH_AUTHORITY);
    expect(verdict.authorized).toBe(false);
    expect(verdict.explanation).toContain(PUBLISH_GATE);
  });

  it("uses `toSubjectHashes` the way a decision records them", () => {
    // Guards the assumption that the digests this package hands the engine are the same shape
    // the engine stores on a decision.
    const hashes = toSubjectHashes(subjects("v1")[UPLOAD_GATE] ?? []);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});
