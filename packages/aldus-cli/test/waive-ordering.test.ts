import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCodes } from "../src/exit.js";
import type { CliOptions, TempWorkspace } from "./helpers.js";
import { gateDefinition, invoke, makeTempWorkspace, subjectsForAll } from "./helpers.js";

/**
 * `waive` through the door people actually use.
 *
 * The engine's rules were tested against `engine.decide` and held there. An adopter measured the
 * same thing through the CLI and got a different answer: the command validated `--reason` itself,
 * ahead of the engine, so an `agent:` actor waiving a `human_oracle` gate with an empty reason was
 * told **it needed a better reason** — when the truth is that it may not decide that gate at all.
 *
 * A check in front of the engine's is not a friendlier copy of it. It is a second rule, and it
 * fires first. These cases exist through the CLI because that is where the ordering was wrong.
 */

let temp: TempWorkspace;
let gated: CliOptions;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  gated = {
    root: temp.root,
    env: { ALDUS_ACTOR: "human:operator-a" },
    gates: [gateDefinition("human-gate", { permittedActorKinds: ["human"] })],
    subjects: subjectsForAll(["human-gate"]),
  };
});

afterEach(async () => {
  await temp.cleanup();
});

/** Create an Episode and a Run: the precondition for a gate decision. */
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

const asAgent = (options: CliOptions): CliOptions => ({
  ...options,
  env: { ALDUS_ACTOR: "agent:waive-probe" },
});

describe("waive refuses in the order the rules belong in", () => {
  it("tells an agent it may not decide the gate, even with no reason at all", async () => {
    const runId = await seed(gated);
    const result = await invoke(asAgent(gated), "waive", "human-gate", "--run", runId);

    // The whole point: not "needs --reason".
    expect(result.stderr).toContain("ALDUS_GATE_ACTOR_NOT_PERMITTED");
    expect(result.stderr).not.toContain("needs --reason");
  });

  it("tells an agent the same thing when the reason is blank", async () => {
    const runId = await seed(gated);
    const result = await invoke(
      asAgent(gated),
      "waive",
      "human-gate",
      "--run",
      runId,
      "--reason",
      "   ",
    );

    expect(result.stderr).toContain("ALDUS_GATE_ACTOR_NOT_PERMITTED");
  });

  it("still refuses a permitted actor who gives no reason", async () => {
    // The control. Removing the CLI's copy must not have removed the rule — it moved it to the
    // one place that knows both rules and the order they belong in.
    const runId = await seed(gated);
    const result = await invoke(gated, "waive", "human-gate", "--run", runId);

    expect(result.code).not.toBe(ExitCodes.success);
    expect(result.stderr).toContain("ALDUS_GATE_WAIVER_INVALID");
  });

  it("records a waiver from a permitted actor who gives one", async () => {
    // The positive control. Without it the refusals above could be measuring a broken command.
    const runId = await seed(gated);
    const result = await invoke(
      gated,
      "waive",
      "human-gate",
      "--run",
      runId,
      "--reason",
      "The oracle is unavailable and this episode is a rerun.",
    );

    expect(result.code).toBe(ExitCodes.success);
  });
});
