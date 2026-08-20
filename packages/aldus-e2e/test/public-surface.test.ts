/**
 * What an adopter can import, checked from where an adopter imports it.
 *
 * Every test inside a package imports its own modules relatively — `../src/worker.js` — and that
 * path exists whether or not the module is re-exported from the package index. An adopter imports
 * by package name and gets only what `index.ts` publishes. **Those are two different surfaces and
 * the package's own tests can only see one of them.**
 *
 * That produced #121: the Worker contract, its registry and the capability check were complete,
 * tested and merged, and `import type { Worker } from "@aldus-runtime/stage-runner"` failed with
 * TS2305 because the export list had been updated for the Agent half and not the Worker half.
 *
 * This package consumes the others by name, so it is the one place that check can live. The
 * assertions are deliberately shallow — presence, not behaviour. Behaviour is tested where it is
 * implemented; what is untestable from there is whether anyone outside can reach it.
 */

import { describe, expect, it } from "vitest";

import * as artifactRegistry from "@aldus-runtime/artifact-registry";
import * as core from "@aldus-runtime/core";
import * as gateEngine from "@aldus-runtime/gate-engine";
import * as stageRunner from "@aldus-runtime/stage-runner";

/**
 * Names an adopter builds against, per package.
 *
 * A seam an adopter is told to implement and cannot import is not a seam. §3.2 tells adopters to
 * prefer Workers over Agents, so the Worker half of this list is the half most likely to be
 * forgotten — it was.
 */
const PUBLIC_SURFACE: Record<string, { module: object; names: readonly string[] }> = {
  "@aldus-runtime/stage-runner": {
    module: stageRunner,
    names: [
      // The Agent half, which was exported.
      "assertCapabilities",
      "StageRegistry",
      "StageRunner",
      // The Worker half, which was not (#121).
      "WorkerRegistry",
      "assertWorkerCapabilities",
      "deriveInvocationKey",
    ],
  },
  "@aldus-runtime/core": {
    module: core,
    names: [
      "QUALITY_LEVELS",
      "QUALITY_ENFORCEMENTS",
      "validateQualityClaim",
      "costObservationSchema",
    ],
  },
  "@aldus-runtime/gate-engine": {
    module: gateEngine,
    names: ["GATE_LEVELS", "GATE_ENFORCEMENTS", "GateEngine", "GateRegistry"],
  },
  "@aldus-runtime/artifact-registry": {
    module: artifactRegistry,
    names: ["ArtifactRegistry", "localPathFromUri"],
  },
};

describe("the published surface is what an adopter can reach (#121)", () => {
  for (const [packageName, { module, names }] of Object.entries(PUBLIC_SURFACE)) {
    it.each(names)(`${packageName} exports %s`, (name) => {
      expect(
        Object.hasOwn(module, name),
        `"${name}" is implemented and not re-exported, so an adopter importing from ` +
          `"${packageName}" cannot reach it. A test inside that package would not notice, because ` +
          "it imports the module relatively.",
      ).toBe(true);
    });
  }

  it("reaches the Worker contract as a type, not only as a value", () => {
    // TS2305 was the adopter's actual failure, and a value check would not have caught it: the
    // types live in the same module and are published by the same line, but a missing `export
    // type` fails only at compile time. `typecheck:test` covers this file, so the import below is
    // the assertion — it does not compile if the types are unreachable.
    const registry: stageRunner.WorkerRegistry = new stageRunner.WorkerRegistry();
    const worker: stageRunner.Worker = {
      id: "probe",
      version: "1",
      capabilities: () => Promise.resolve({ offers: [] }),
      execute: (request: stageRunner.WorkerRequest) =>
        Promise.resolve({ output: request.input } satisfies stageRunner.WorkerResult),
    };
    registry.register(worker);
    expect(registry.list()).toEqual([{ id: "probe", version: "1" }]);
  });
});
