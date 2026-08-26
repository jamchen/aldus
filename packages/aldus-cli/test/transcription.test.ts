import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCodes } from "../src/exit.js";
import type { CliOptions, TempWorkspace } from "./helpers.js";
import { gateDefinition, invoke, makeTempWorkspace, subjectsForAll } from "./helpers.js";

/**
 * Recording a decision someone else made (§19.2, ADR-0054).
 *
 * `decidedBy` alone covered two events — the person typed it, and the person decided it while
 * something else typed it — and nothing authenticates an actor string, so the misleading shape was
 * always available and the honest one was not. Forced by an owner on a phone: `!` is a terminal
 * feature, their approval never reached the runtime, and the only path open to their adopter was
 * typing the owner's identity.
 *
 * Driven through the CLI because that is the door, and because the transcriber is **derived** from
 * the acting actor — a property that only exists on the path where an acting actor exists.
 */

let temp: TempWorkspace;
let gated: CliOptions;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  gated = {
    root: temp.root,
    env: { ALDUS_ACTOR: "agent:coordinator" },
    gates: [gateDefinition("human-gate", { permittedActorKinds: ["human"] })],
    subjects: subjectsForAll(["human-gate"]),
  };
});

afterEach(async () => {
  await temp.cleanup();
});

async function seed(options: CliOptions): Promise<string> {
  await invoke(options, "init", "--show", "example-show", "--slug", "episode-a");
  const started = await invoke(
    options,
    "start",
    "--workflow",
    "workflow-a",
    "--workflow-version",
    "1",
    "--json",
  );
  return (started.json() as { data: { run: { runId: string } } }).data.run.runId;
}

describe("an agent can record a decision a human made", () => {
  it("records the human as decider and the agent as transcriber", async () => {
    // The case that could not be expressed. An agent acting, a human deciding, and a record that
    // says which is which — where before the only option was to claim the human was acting.
    const runId = await seed(gated);
    const result = await invoke(
      gated,
      "approve",
      "human-gate",
      "--run",
      runId,
      "--decided-by",
      "human:jamchen",
      "--verbatim",
      "同意，可以 freeze",
      "--json",
    );

    expect(result.code).toBe(ExitCodes.success);
  });

  it("refuses --decided-by without --verbatim", async () => {
    // A transcription with no record of what was said is attributable and not checkable.
    const runId = await seed(gated);
    const result = await invoke(
      gated,
      "approve",
      "human-gate",
      "--run",
      runId,
      "--decided-by",
      "human:jamchen",
    );

    expect(result.stderr).toContain("needs `--verbatim`");
  });

  it("refuses --verbatim without --decided-by", async () => {
    const runId = await seed(gated);
    const result = await invoke(
      gated,
      "approve",
      "human-gate",
      "--run",
      runId,
      "--verbatim",
      "同意",
    );

    expect(result.stderr).toContain("needs `--decided-by`");
  });

  it("still refuses an agent deciding for itself, so this is not a route past the gate", async () => {
    // The control that matters most. `recordedBy` names a transcriber; it grants nobody anything,
    // and `permittedActorKinds` still applies to `decidedBy`.
    const runId = await seed(gated);
    const result = await invoke(gated, "approve", "human-gate", "--run", runId);

    expect(result.stderr).toContain("ALDUS_GATE_ACTOR_NOT_PERMITTED");
  });

  it("still refuses when the agent names another agent as decider", async () => {
    // Transcription does not launder the actor kind: the rule applies to who decided.
    const runId = await seed(gated);
    const result = await invoke(
      gated,
      "approve",
      "human-gate",
      "--run",
      runId,
      "--decided-by",
      "agent:other",
      "--verbatim",
      "ok",
    );

    expect(result.stderr).toContain("ALDUS_GATE_ACTOR_NOT_PERMITTED");
  });
});

describe("the transcriber is derived, not supplied", () => {
  it("names the acting actor as recordedBy whatever the caller wanted", async () => {
    // A transcriber that could name itself could name someone else, so `recordedBy` comes from the
    // acting actor and there is no flag for it. This reads the written decision back to check that
    // the record says who was actually running the command.
    const runId = await seed(gated);
    await invoke(
      gated,
      "approve",
      "human-gate",
      "--run",
      runId,
      "--decided-by",
      "human:jamchen",
      "--verbatim",
      "同意",
    );

    // Read the **decision record**, not `status`. My first version of this asserted against
    // `status --json` and both mutations survived at 6 of 6 — "coordinator" appeared there for an
    // unrelated reason, so the test held whether or not the transcription was ever written. Third
    // time today an assertion of mine was true for another reason, and this one was written to
    // guard against exactly that.
    const approvals = JSON.parse(
      await readFile(join(temp.root, ".aldus", "runs", runId, "approvals.json"), "utf8"),
    ) as {
      decidedBy: { id: string };
      transcription?: { recordedBy: { id: string }; verbatim: string };
    }[];

    const decision = approvals.at(-1);
    expect(decision?.decidedBy.id).toBe("jamchen");
    expect(decision?.transcription?.recordedBy.id).toBe("coordinator");
    expect(decision?.transcription?.verbatim).toBe("同意");
  });
});
