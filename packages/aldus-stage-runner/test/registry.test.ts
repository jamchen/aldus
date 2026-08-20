/**
 * The stage registry (architecture contract §11, §20).
 *
 * §11 makes a workflow "a versioned graph of stages and gates", so a stage is identified by id and
 * version together. The rule worth pinning is that registration is not idempotent: silently
 * accepting a second definition under one version would make §20 unable to say which one ran.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { StageRunnerErrorCodes } from "../src/errors.js";
import { StageRegistry } from "../src/registry.js";
import { aStage } from "./helpers.js";

describe("StageRegistry", () => {
  it("resolves a stage by id and version", () => {
    const registry = new StageRegistry().register(aStage({ version: "1.0.0" }));
    expect(registry.require("stage-a", "1.0.0").version).toBe("1.0.0");
    expect(registry.has("stage-a", "1.0.0")).toBe(true);
  });

  it("keeps every version resolvable at once", () => {
    const registry = new StageRegistry()
      .register(aStage({ version: "1.0.0" }))
      .register(aStage({ version: "2.0.0" }));

    // §20 requires a completed Run to stay explicable: a Run that executed 1.0.0 must still be
    // readable after 2.0.0 is registered.
    expect(registry.versionsOf("stage-a")).toEqual(["1.0.0", "2.0.0"]);
    expect(registry.require("stage-a", "1.0.0").version).toBe("1.0.0");
    expect(registry.require("stage-a", "2.0.0").version).toBe("2.0.0");
  });

  it("refuses to register the same id and version twice", () => {
    const registry = new StageRegistry().register(aStage({ version: "1.0.0" }));
    expect(() => registry.register(aStage({ version: "1.0.0" }))).toThrowError(
      /already registered/,
    );
    try {
      registry.register(aStage({ version: "1.0.0" }));
    } catch (error) {
      expect((error as { code: string }).code).toBe(StageRunnerErrorCodes.STAGE_ALREADY_REGISTERED);
    }
  });

  it("names the registered versions when a lookup misses", () => {
    const registry = new StageRegistry()
      .register(aStage({ version: "1.0.0" }))
      .register(aStage({ version: "1.1.0" }));
    // The usual cause is a workflow pinned to a version that has moved; listing what exists turns
    // a dead end into a diagnosis.
    expect(() => registry.require("stage-a", "9.9.9")).toThrowError(/1\.0\.0, 1\.1\.0/);
  });

  it("distinguishes an unknown id from an unknown version", () => {
    const registry = new StageRegistry().register(aStage({ version: "1.0.0" }));
    expect(() => registry.require("stage-missing", "1.0.0")).toThrowError(/No stage is registered/);
    expect(() => registry.require("stage-a", "2.0.0")).toThrowError(/has no version/);
  });

  it("returns undefined rather than throwing for an optional lookup", () => {
    const registry = new StageRegistry();
    expect(registry.get("stage-a", "1.0.0")).toBeUndefined();
    expect(registry.has("stage-a", "1.0.0")).toBe(false);
  });

  it("lists ids and versions in a stable order", () => {
    const registry = new StageRegistry()
      .register(aStage({ id: "stage-b", version: "2.0.0" }))
      .register(aStage({ id: "stage-a", version: "1.0.0" }))
      .register(aStage({ id: "stage-b", version: "1.0.0" }));
    expect(registry.ids()).toEqual(["stage-a", "stage-b"]);
    expect(registry.versionsOf("stage-b")).toEqual(["1.0.0", "2.0.0"]);
  });

  it("reports no versions for an unregistered id", () => {
    expect(new StageRegistry().versionsOf("stage-missing")).toEqual([]);
  });

  it("preserves the declared schemas and policies", () => {
    const registry = new StageRegistry().register(
      aStage({
        inputSchema: z.object({ topic: z.string() }) as never,
        requiredCapabilities: ["filesystem"],
        retryPolicy: { maxAttempts: 3 },
        costPolicy: { supportsPreview: true, requiresAuthorization: true },
        artifacts: { produces: "none" },
        idempotency: { kind: "not_idempotent", reason: "issues a paid request" },
      }),
    );
    const definition = registry.require("stage-a", "1.0.0");
    expect(definition.requiredCapabilities).toEqual(["filesystem"]);
    expect(definition.retryPolicy?.maxAttempts).toBe(3);
    expect(definition.costPolicy?.requiresAuthorization).toBe(true);
    expect(definition.idempotency).toEqual({
      kind: "not_idempotent",
      reason: "issues a paid request",
    });
  });
});
