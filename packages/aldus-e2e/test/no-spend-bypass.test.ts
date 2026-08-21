/**
 * No path to a paid effect bypasses spend reservation (#155 step 4, #107).
 *
 * This file used to enumerate `["SynthesisGateway", "AgentExecutionService"]` and assert each was
 * exported with a spend service. Every assertion was true and the property was false: `runWorker`
 * was a third paid path — §3.2's Workers include TTS invocation and rendering — and it reserved
 * nothing, recorded nothing, and was not on the list. The list went stale the moment the Worker
 * cost channel landed, and it was a measurement rather than a name check that found it.
 *
 * So the enumeration is gone. What each path *does* is asserted where it can be observed:
 *
 * - `worker-spend.test.ts` — a paid Worker reaches no provider without a committed reservation,
 *   and what it reports appears in `services.costs(runId)`;
 * - `packages/aldus-services/test/synthesis.test.ts` — the same for synthesis;
 * - `packages/aldus-services/test/spend-reservation.test.ts` — the same for agent execution.
 *
 * What remains here is the one property no behavioural test can state: that the composition root
 * wires spend into every gateway it builds, and that a new paid path cannot be added without
 * someone noticing.
 */

import { describe, expect, it } from "vitest";

import * as services from "@aldus-runtime/services";

describe("the composition root wires spend into every paid path it builds", () => {
  it("passes a spend service to every gateway construction in the composition root", async () => {
    // Asserted against the source because the alternative — constructing every gateway and
    // introspecting a private field — is a test of reflection rather than of composition.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../aldus-services/src/context.ts", import.meta.url), "utf8"),
    );

    const synthesisConstruction = source.slice(
      source.indexOf("new SynthesisGateway({"),
      source.indexOf("});", source.indexOf("new SynthesisGateway({")),
    );
    expect(synthesisConstruction).toContain("spend");

    // The Worker path, which had no wiring at all until #107. `runnerFor` is what an adopter's
    // stages execute through, and a runner built without a spend controller refuses every paid
    // Worker invocation — correct, and useless as a product.
    const runnerConstruction = source.slice(
      source.indexOf("createStageRunner(this.workspace, {"),
      source.indexOf("});", source.indexOf("createStageRunner(this.workspace, {")),
    );
    expect(runnerConstruction).toContain("paidDispatch");
  });

  it("gives the Stage Runner a spend port it can refuse through", () => {
    // The port is what makes fail-closed possible without `stage-runner` depending upward. Its
    // absence is what let a paid Worker dispatch with nothing to check it (§4.3).
    const controller = services.RuntimePaidDispatchController.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const method of [
      "reserve",
      "prepareDispatch",
      "settle",
      "markUnknown",
      "releaseBeforeDispatch",
      "recordUnauthorized",
    ]) {
      expect(typeof controller[method]).toBe("function");
    }
  });

  it("SpendService exposes the lifecycle a paid path needs, and no more", () => {
    // `reconcile` and `status` arrived with step 5, which is why this assertion changed rather
    // than the surface quietly growing past it. What stays out is `list` and `inspect`: the ruling
    // permits them to wait, and shipping a seam nobody drives is how one comes to look supported.
    const spend = services.SpendService.prototype as unknown as Record<string, unknown>;
    for (const method of [
      "reserve",
      "prepareDispatch",
      "identifyDispatch",
      "settle",
      "releaseBeforeDispatch",
      "markUnknown",
      "reconcile",
      "status",
    ]) {
      expect(typeof spend[method]).toBe("function");
    }
    for (const notYet of ["list", "inspect"]) {
      expect(spend[notYet]).toBeUndefined();
    }
  });
});

describe("no published surface mints reconciliation authority (#155 step 5)", () => {
  /**
   * The third correction, and the one that finally has the right shape.
   *
   * Two earlier versions tried to establish "a human decided this" from an `ActorRef` the caller
   * supplied — first a public constructor, then a public factory. Both put the evidence-free half
   * of the pair in a caller's hands while a `WeakSet` made the result look established. The
   * composed path did not repair it: `AldusContext.actor` comes from `--actor` or `ALDUS_ACTOR`,
   * which says who a command claims to be and nothing more.
   *
   * Aldus has no boundary that authenticates an operator, so it does not claim one. Status ships
   * read-only, `reconcile` requires an authority nothing published can mint, and these tests are
   * what keeps that true.
   */
  it("publishes no way to obtain an operator console", () => {
    for (const name of ["openOperatorConsole", "OperatorSpendConsole", "OperatorAuthority"]) {
      expect(
        Object.hasOwn(services, name),
        `"${name}" is exported from @aldus-runtime/services. Anything a caller can reach that ` +
          "yields an OperatorAuthority is a mint, and the actor it would take is a claim rather " +
          "than evidence.",
      ).toBe(false);
    }
  });

  it("gives the composition root a read-only spend surface and no console", async () => {
    const { AldusContext } = services as unknown as {
      AldusContext: { prototype: Record<string, unknown> };
    };
    expect(typeof AldusContext.prototype["spendStatus"]).toBe("function");
    // Removed rather than never added. It existed, wired to the self-declared CLI actor, and that
    // is exactly the composition that made the mint look trustworthy.
    expect(AldusContext.prototype["operatorConsole"]).toBeUndefined();
  });

  it("refuses an assembled authority, so reconcile is unreachable rather than weakly guarded", async () => {
    // The only remaining way in is to build the object. `isIssuedOperatorAuthority` is set
    // membership, so a literal with the right fields proves only that a caller can type them.
    const spend = services.SpendService.prototype as unknown as {
      reconcile: (...args: unknown[]) => Promise<unknown>;
    };
    await expect(
      spend.reconcile.call(
        Object.create(services.SpendService.prototype) as unknown,
        { reservationId: "res-a", grantId: "grant-a" },
        { decisionId: "d", evidenceRef: "e", resolution: { kind: "investigation_ended" } },
        { actor: { kind: "human", id: "whoever" } },
      ),
    ).rejects.toThrow(/did not come through an operator console/);
  });
});
