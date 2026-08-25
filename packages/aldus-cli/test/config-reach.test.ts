/**
 * Every capability an adopter is expected to supply must be reachable from a config file.
 *
 * Four integration gaps have now had one shape: the seam existed, its tests passed, and no
 * adopter could reach it because `AldusConfig` had no field for it.
 *
 * | gap | seam existed | config could reach it |
 * | --- | --- | --- |
 * | #46 `workflow` | yes | no, until fixed |
 * | AF-14 `agentBackend` | yes | no, until #121 |
 * | #111 `workers` | yes | no, until #121 |
 * | AF-18 `takeDecisionActorKinds` | yes | no, and **the refusal named it as the remedy** |
 *
 * The fourth is the worst of them: `ALDUS_TTS_TAKE_ACTOR_NOT_PERMITTED` told an adopter to declare
 * the option, and declaring it produced `ALDUS_CONFIG_UNKNOWN_KEY`. Following the message was
 * refused for having followed it. A remedy an adopter cannot perform is worse than no remedy.
 *
 * Each was found by an adopter trying to use a finished feature, and package tests passed every
 * time — because a `StageRunner` or `AldusContext` constructed directly in a test *can* be handed
 * the option, and that is precisely the composition an adopter never writes.
 *
 * A test double does not catch this either: it plugs into the runner, not into the config. So the
 * check has to compare the two surfaces rather than exercise either one.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, type AldusConfig } from "../src/config.js";

let dir: string | undefined;
/** One throwaway directory for the config modules these cases write. */
async function workspace(): Promise<string> {
  dir ??= await mkdtemp(join(tmpdir(), "aldus-config-reach-"));
  return dir;
}

/**
 * Capabilities an adopter supplies, and the `AldusConfig` field that carries each.
 *
 * Adding a composition option without adding it here fails the test below, which is the point:
 * the omission has to be deliberate and stated rather than discovered by an adopter.
 */
const ADOPTER_SUPPLIED: Record<string, keyof AldusConfig> = {
  "stage definitions": "stages",
  "gate definitions": "gates",
  "gate subjects": "subjects",
  "release adapters": "releaseAdapters",
  "synthesis adapter": "synthesisAdapter",
  "spend grants": "spendGrants",
  "workflow graph": "workflow",
  workers: "workers",
  "agent backend": "agentBackend",
  "worker spend grants": "dispatchSpendGrants",
  "take decision actor kinds": "takeDecisionActorKinds",
};

/**
 * Options a composition accepts that an adopter is **not** expected to supply, with the reason.
 *
 * Listed rather than omitted, so "no config field" is a recorded decision instead of an oversight.
 * This is the half that makes the check honest: without it, every new internal option would either
 * fail the test or force a config field nobody wants.
 */
const DELIBERATELY_NOT_IN_CONFIG: Record<string, string> = {
  actor: "supplied per invocation by --actor or ALDUS_ACTOR, not per composition",
  now: "injected by tests for determinism; a config-supplied clock would be a foot-gun",
  archive:
    "reachable through the config, but as an artifact-archive concern rather than a runner option",
};

describe("every adopter-supplied capability has a config field (#121)", () => {
  it.each(Object.entries(ADOPTER_SUPPLIED))("an adopter can supply %s", async (_label, field) => {
    // **This assertion used to be decoration**, and that is why AF-18 happened a fourth time.
    //
    // It built `{ [field]: undefined }` and asserted the object had `field` — trivially true for
    // any string, touching neither `KNOWN_CONFIG_KEYS` nor `loadConfig`. Its own comment claimed
    // "a config carrying it must survive `loadConfig`'s unknown-key refusal", which it never
    // checked: a description that had drifted from its mechanism, inside the test written to stop
    // exactly this class. Removing a key from the known list left all cases green.
    //
    // Now it writes a real config module and loads it, which is the only thing that exercises the
    // list an adopter actually collides with.
    const file = join(await workspace(), `config-${field}.mjs`);
    await writeFile(file, `export default { ${field}: undefined };\n`, "utf8");

    await expect(
      loadConfig(file, dirname(file), { workspace: dirname(file) }),
    ).resolves.toBeDefined();
  });

  it("fails when a known key is removed, so the case above is not decoration again", async () => {
    // The control on the control. A field that is *not* in KNOWN_CONFIG_KEYS must be refused, or
    // the cases above would pass for any name and we would be back where we started.
    const file = join(await workspace(), "config-unknown.mjs");
    await writeFile(file, "export default { notAKnownKey: 1 };\n", "utf8");

    await expect(loadConfig(file, dirname(file), { workspace: dirname(file) })).rejects.toThrow(
      /notAKnownKey/,
    );
  });

  it("refuses a key it does not know, which is why omissions are fatal rather than ignored", async () => {
    // The reason a missing field cannot be worked around: `loadConfig` throws on an unknown key,
    // so an adopter cannot smuggle a capability through. That strictness is correct (ADR-0025) and
    // it is exactly what makes an absent field a hard block rather than an inconvenience.
    await expect(
      loadConfig("./nonexistent-config.mjs", process.cwd(), { workspace: "/tmp" }),
    ).rejects.toBeDefined();
  });

  it("records why an option is absent from the config rather than leaving it unexplained", () => {
    // Every entry needs a reason. An empty reason is an omission wearing a decision's clothes.
    for (const [option, reason] of Object.entries(DELIBERATELY_NOT_IN_CONFIG)) {
      expect(reason.length, `"${option}" is listed as deliberate with no reason`).toBeGreaterThan(
        20,
      );
    }
  });
});
