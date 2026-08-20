/**
 * The operator's actual command, against a config module on disk.
 *
 * Four boundaries failed in one day, each one further out than the test written for the last:
 *
 * | boundary | caught by |
 * | --- | --- |
 * | does the seam exist | a contract audit — which missed it |
 * | is it exported from the package | a public-surface test, added after an adopter hit it |
 * | does `AldusConfig` declare it | added after an adopter hit it |
 * | does `loadConfig` accept the key | **nothing** — an adopter hit it |
 *
 * Each test was written at the boundary just learned about, and the failure moved one step past
 * it. The adopter's diagnosis, which is why this file exists rather than a fifth check at the
 * fourth boundary: the test that would have caught all four **runs the CLI against a config module
 * on disk** — not `AldusConfig` as a type, not the runner as a class, but the operator's command.
 *
 * So this is deliberately end-to-end and deliberately unglamorous. It writes a real `.mjs`, hands
 * it to `--config`, and asserts the capability reached the composition.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initWorkspace } from "@aldus-runtime/file-store";

import { invoke, makeTempWorkspace, type TempWorkspace } from "./helpers.js";

let temp: TempWorkspace;
let elsewhere: string;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  elsewhere = await mkdtemp(join(tmpdir(), "aldus-operator-"));
  await initWorkspace(temp.root);
});

afterEach(async () => {
  await temp.cleanup();
});

/** Write a config module the way an adopter writes one, and return its path. */
async function configModule(body: string): Promise<string> {
  const path = join(elsewhere, `aldus.config.${Math.abs(body.length)}.mjs`);
  await writeFile(path, body, "utf8");
  return path;
}

describe("an adopter's config module reaches the composition (#123)", () => {
  it("accepts a config that supplies a Worker registry", async () => {
    // The exact failure: `workers` was typed on AldusConfig, read by the CLI, passed to the
    // context — and refused by loadConfig's allowlist before that code could run. A TypeScript
    // adopter wrote a field they could see in the type and was told at runtime it did not exist.
    const path = await configModule(
      [
        // Structurally a registry, without importing the package: module resolution from a temp
        // directory is a different question, and a config that failed to *load* would satisfy a
        // "did not complain about the key" assertion while proving nothing.
        "const workers = { register() {}, find() {}, require() {}, list: () => [] };",
        "export default { stages: [], workers };",
      ].join("\n"),
    );

    const result = await invoke({ root: temp.root }, "status", "--config", path);

    // Positive, deliberately. `not.toContain("ALDUS_CONFIG_UNKNOWN_KEY")` passes when the config
    // fails for some *other* reason — which is exactly how the first version of this test passed
    // against the defect it exists to catch.
    expect(result.stderr, result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("accepts a config that supplies an agent backend", async () => {
    // The same gap, older: AldusContext has accepted a backend since it was written, and nothing
    // could supply one from a config.
    const path = await configModule(
      [
        "const agentBackend = {",
        '  id: "backend-a",',
        "  capabilities: async () => ({ offers: [], interactive: false, resumable: false }),",
        "  execute: async () => ({ ok: true }),",
        "};",
        "export default { stages: [], agentBackend };",
      ].join("\n"),
    );

    const result = await invoke({ root: temp.root }, "status", "--config", path);

    expect(result.stderr, result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("still refuses a key Aldus genuinely does not know", async () => {
    // The strictness is correct (ADR-0025) and must survive: it is what makes a missing key a
    // hard block rather than a silently dropped field. This test is the reason the fix above is
    // an exhaustive allowlist rather than removing the check.
    const path = await configModule("export default { stages: [], notAThing: 1 };");

    const result = await invoke({ root: temp.root }, "status", "--config", path);

    expect(result.stderr).toContain("ALDUS_CONFIG_UNKNOWN_KEY");
  });
});
