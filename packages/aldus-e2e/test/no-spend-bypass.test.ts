/**
 * No path to a paid effect bypasses spend reservation (#155 step 4).
 *
 * The completion criterion for step 4 is not a list of adopted gateways — lists go stale — but the
 * property that a paid effect cannot happen without a reservation having been committed first.
 * This asserts it from the published surface, the way `public-surface.test.ts` asserts
 * reachability: a package's own tests cannot see what an adopter can reach.
 */

import { describe, expect, it } from "vitest";

import * as services from "@aldus-runtime/services";

/**
 * Every published symbol that dispatches a paid provider effect.
 *
 * A new one added without a reservation is what this exists to catch. The list is the part a
 * future author has to edit, and editing it is the moment to ask whether the new path reserves.
 */
const PAID_DISPATCH_SURFACES = ["SynthesisGateway", "AgentExecutionService"] as const;

describe("every paid dispatch path reserves before the effect", () => {
  it.each(PAID_DISPATCH_SURFACES)("%s is constructible with a SpendService", (name) => {
    // Presence, not behaviour: the behaviour is tested where each gateway lives. What cannot be
    // tested there is whether the composition an adopter writes can reach the protection.
    expect(Object.hasOwn(services, name)).toBe(true);
  });

  it("the composed context wires spend into every paid gateway it builds", async () => {
    // The half a per-package test cannot establish. `AldusContext` is what an adopter composes,
    // and a gateway it builds without a spend service would enforce budget only between durably
    // recorded executions — which is not what #155 claims.
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../aldus-services/src/context.ts", import.meta.url), "utf8"),
    );

    // Both constructions in the composition root pass a spend service. Asserted against the source
    // because the alternative — constructing every gateway and introspecting a private field — is
    // a test of reflection rather than of composition.
    const synthesisConstruction = source.slice(
      source.indexOf("new SynthesisGateway({"),
      source.indexOf("});", source.indexOf("new SynthesisGateway({")),
    );
    expect(synthesisConstruction).toContain("spend");
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
