import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * `costs abandon` — the verb a stranded reservation had no way to reach (#226).
 *
 * A process killed between `reserve` and any billing outcome leaves the reservation `reserved`:
 * nothing survived to classify it, so it never became `billing_unknown`, and `costs settle` accepts
 * only `billing_unknown`. The first adopter's `aldus costs` listed a reservation holding $12.00 and
 * named `costs settle` as its resolution, and `settle` refused it — the one place that tells an
 * operator what to do naming the one command that would refuse them.
 */

let temp: TempWorkspace;
let base: CliOptions;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  base = { root: temp.root, env: { ALDUS_ACTOR: "human:operator-a" } };
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

describe("the verb exists and states its own preconditions", () => {
  it("needs a reservation id", async () => {
    const runId = await seed(base);
    const result = await invoke(base, "costs", "abandon", "--run", runId);
    expect(result.stderr).toContain("needs a reservation id");
  });

  it("requires --verbatim with --decided-by", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "abandon",
      "res-x",
      "--run",
      runId,
      "--reason",
      "killed mid-dispatch",
      "--decided-by",
      "human:jamchen",
    );
    expect(result.stderr).toContain("needs `--verbatim`");
  });

  it("refuses without a reason, because an unattributed abandon is indistinguishable", async () => {
    // A reservation moved out of `reserved` with no stated reason reads exactly like one the
    // runtime classified itself, which is the distinction the verb exists to make.
    const runId = await seed(base);
    const result = await invoke(base, "costs", "abandon", "res-x", "--run", runId);
    expect(result.stderr).toContain("needs a reason");
  });

  it("says which reservation it could not find rather than failing opaquely", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "abandon",
      "res-missing",
      "--run",
      runId,
      "--reason",
      "killed mid-dispatch",
    );
    expect(result.stderr).toContain("res-missing");
  });

  it("leaves `costs show` and `costs settle` reachable", async () => {
    // The control. Adding a second subcommand must not take the default or shadow the first.
    const runId = await seed(base);
    expect((await invoke(base, "costs", "--run", runId)).code).toBe(0);
    expect((await invoke(base, "costs", "show", "--run", runId)).code).toBe(0);
    expect((await invoke(base, "costs", "settle", "--run", runId)).stderr).toContain(
      "needs a reservation id",
    );
  });
});
