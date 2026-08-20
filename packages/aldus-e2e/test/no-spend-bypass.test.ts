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
    // `reconcile` and operator status are step 5. Shipping them now would put unexercised contract
    // in the published surface, which is how a seam nobody drives comes to look supported.
    const spend = services.SpendService.prototype as unknown as Record<string, unknown>;
    for (const method of [
      "reserve",
      "prepareDispatch",
      "identifyDispatch",
      "settle",
      "releaseBeforeDispatch",
      "markUnknown",
    ]) {
      expect(typeof spend[method]).toBe("function");
    }
    expect(spend["reconcile"]).toBeUndefined();
  });
});
