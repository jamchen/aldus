import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * `aldus rework status` is reachable (#220).
 *
 * It was not. The dispatch passed `argv.slice(1)` where every other command passes `argv`, so the
 * first real argument was eaten and `aldus rework status --run <id>` parsed `--run` as the
 * subcommand and refused. **The command was unusable in `0.2.0-next.49` and nothing caught it**:
 * the tests written for it exercised `renderRework` with hand-built reports, so they could not see
 * the command failing to reach the renderer at all.
 *
 * That is the same defect as the `options.actor?.kind` wiring found by mutation earlier the same
 * day — an assertion that is also true when the mechanism is absent — repeated in a new command
 * hours after writing the test that exists to prevent it. So these invoke the CLI.
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

describe("the command reaches the renderer", () => {
  it("runs `rework status --run <id>`", async () => {
    const runId = await seed(base);

    const result = await invoke(base, "rework", "status", "--run", runId);

    expect(result.stderr).not.toContain("is not a command");
    expect(result.stdout).toContain("No rework policy is declared");
    expect(result.code).toBe(0);
  });

  it("treats a bare `rework --run <id>` as status", async () => {
    // `costs` behaves this way and an operator will type it. Refusing here named `--run` as the
    // subcommand, which is a message about the parser rather than about anything they did.
    const runId = await seed(base);

    const result = await invoke(base, "rework", "--run", runId);

    expect(result.stdout).toContain("No rework policy is declared");
    expect(result.code).toBe(0);
  });

  it("still refuses a subcommand that is not one, and names it", async () => {
    // The control. Without it, "does not say `is not a command`" would also hold for a dispatch
    // that accepts everything — and the message must name what the operator typed, not `--run`.
    const runId = await seed(base);

    const result = await invoke(base, "rework", "demolish", "--run", runId);

    expect(result.stderr).toContain("demolish");
    expect(result.stderr).toContain("is not a command");
  });
});
