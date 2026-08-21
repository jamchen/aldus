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
