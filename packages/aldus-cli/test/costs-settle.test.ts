import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * `costs settle` — the door to a reconciliation nothing could reach (#215).
 *
 * `SpendService.reconcile` has been able to resolve an unresolved charge since the reservation
 * protocol landed, behind a console whose only mint was removed from the composition root. So a
 * reservation left `billing_unknown` made a Run **terminal**: the only exit was `cancel`, which
 * discards approvals and artifacts because both are Run-scoped. An adopter lost two `human_oracle`
 * decisions and $12.57 of settled work to a bookkeeping state whose own error said `Nothing was
 * spawned`.
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
    const result = await invoke(base, "costs", "settle", "--run", runId);
    expect(result.stderr).toContain("needs a reservation id");
  });

  it("refuses --amount together with --uncharged, which are different findings", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "settle",
      "res-x",
      "--run",
      runId,
      "--amount",
      "0",
      "--uncharged",
      "--evidence",
      "the dispatch error said nothing was spawned",
    );
    expect(result.stderr).toContain("different findings");
  });

  it("says which reservation it could not find rather than failing opaquely", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "settle",
      "res-missing",
      "--run",
      runId,
      "--uncharged",
      "--evidence",
      "e",
    );
    expect(result.stderr).toContain("res-missing");
  });

  it("requires --verbatim with --decided-by", async () => {
    const runId = await seed(base);
    const result = await invoke(
      base,
      "costs",
      "settle",
      "res-x",
      "--run",
      runId,
      "--uncharged",
      "--evidence",
      "e",
      "--decided-by",
      "human:jamchen",
    );
    expect(result.stderr).toContain("needs `--verbatim`");
  });

  it("leaves `costs show` reachable, so adding a subcommand did not take the default", async () => {
    // The control. `costs` and `costs show` must both still print the summary.
    const runId = await seed(base);
    expect((await invoke(base, "costs", "--run", runId)).code).toBe(0);
    expect((await invoke(base, "costs", "show", "--run", runId)).code).toBe(0);
  });
});
