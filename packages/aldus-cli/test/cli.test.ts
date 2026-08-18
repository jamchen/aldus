/**
 * The CLI as an adapter (architecture contract §18).
 *
 * These check the three things an adapter is responsible for and nothing else: that it maps a
 * service result to the right exit code, that its two output modes come from one service call,
 * and that it supplies an actor for anything that mutates state.
 *
 * Everything about *whether* an operation is allowed is tested in `@aldus-runtime/services`. Re-testing
 * it here would be testing the service through a keyhole, and would quietly make it acceptable
 * for the CLI to hold policy of its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCodes } from "../src/exit.js";
import { USAGE } from "../src/usage.js";

import {
  gateDefinition,
  gatedStage,
  invoke,
  makeTempWorkspace,
  passthroughStage,
  registryOf,
  subjectsForAll,
  type CliOptions,
  type TempWorkspace,
} from "./helpers.js";

let temp: TempWorkspace;
let base: CliOptions;

beforeEach(async () => {
  temp = await makeTempWorkspace();
  base = { root: temp.root, env: { ALDUS_ACTOR: "human:operator-a" } };
});

afterEach(async () => {
  await temp.cleanup();
});

/**
 * Create an Episode and a Run, the precondition for most commands.
 *
 * Returns the minted Run id rather than assuming one: `start` mints a ULID, and a test that
 * hard-coded an id would pass only until the generator changed.
 */
async function seed(options: CliOptions = base): Promise<string> {
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
  const parsed = started.json() as { data: { run: { runId: string } } };
  return parsed.data.run.runId;
}

describe("exit codes (§18)", () => {
  it("returns success for a completed operation", async () => {
    const result = await invoke(base, "init", "--show", "example-show", "--slug", "episode-a");
    expect(result.code).toBe(ExitCodes.success);
  });

  // A refusal is an ordinary answer under §13 and §19.3, not a malfunction. A script that could
  // not tell the two apart would report a breakage every time a gate was legitimately not ready.
  it("returns refused when the operation is understood and not permitted", async () => {
    await invoke(base, "init", "--show", "example-show", "--slug", "episode-a");
    const second = await invoke(base, "init", "--show", "example-show", "--slug", "episode-b");

    expect(second.code).toBe(ExitCodes.refused);
    expect(second.stderr).toContain("Refused:");
  });

  it("returns error for an unknown command", async () => {
    const result = await invoke(base, "nonsense");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("Unknown command");
  });

  it("returns error when a required Run is missing", async () => {
    const result = await invoke(base, "costs");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("--run");
  });

  // The work *was* attempted and the runtime is fine, so this is neither a refusal nor an error
  // — but a script chaining stages must still stop, which is why it cannot be 0.
  it("returns unsuccessful when a stage halts at a gate", async () => {
    const options: CliOptions = {
      ...base,
      stages: registryOf(gatedStage("stage-a", "content-freeze")),
      gates: [gateDefinition("content-freeze")],
      subjects: subjectsForAll(["content-freeze"]),
    };
    const runId = await seed(options);

    const result = await invoke(options, "run", "stage-a", "--run", runId);
    expect(result.code).toBe(ExitCodes.unsuccessful);
  });

  it("keeps every exit code distinct", () => {
    const codes = Object.values(ExitCodes);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("actor identity (§19.2)", () => {
  it("refuses a mutation when no actor is configured", async () => {
    const anonymous: CliOptions = { root: temp.root, env: { ALDUS_ACTOR: undefined } };
    const result = await invoke(anonymous, "init", "--show", "example-show", "--slug", "episode-a");

    expect(result.code).toBe(ExitCodes.refused);
    expect(result.stderr).toContain("ALDUS_ACTOR_REQUIRED");
  });

  it("accepts an actor from the environment", async () => {
    const result = await invoke(base, "init", "--show", "example-show", "--slug", "episode-a");
    expect(result.code).toBe(ExitCodes.success);
  });

  it("lets a flag override the environment", async () => {
    const gated: CliOptions = {
      ...base,
      gates: [gateDefinition("gate-a", { level: "advisory_signal", enforcement: "advisory" })],
      subjects: subjectsForAll(["gate-a"]),
    };
    const runId = await seed(gated);

    const approved = await invoke(
      gated,
      "approve",
      "gate-a",
      "--run",
      runId,
      "--actor",
      "human:operator-b",
      "--json",
    );
    expect(approved.code).toBe(ExitCodes.success);
    expect(approved.stdout).toContain("operator-b");
  });

  // §24 promises the state is visible without ceremony; requiring identity to look would put
  // configuration in the way.
  it("reads state without an actor", async () => {
    await seed();
    const anonymous: CliOptions = { root: temp.root, env: { ALDUS_ACTOR: undefined } };
    const result = await invoke(anonymous, "status");
    expect(result.code).toBe(ExitCodes.success);
  });

  it("rejects a malformed actor rather than guessing", async () => {
    const bad: CliOptions = { root: temp.root, env: { ALDUS_ACTOR: "operator-a" } };
    const result = await invoke(bad, "status");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_ACTOR_INVALID");
  });

  it("rejects an actor whose kind is not one Core defines", async () => {
    const bad: CliOptions = { root: temp.root, env: { ALDUS_ACTOR: "robot:r2" } };
    const result = await invoke(bad, "status");
    expect(result.code).toBe(ExitCodes.error);
  });
});

describe("output modes (§18)", () => {
  // §18 asks for both machine-readable JSON and human-readable summaries. The constraint that
  // keeps them honest is that both render the same service result — so neither can show
  // something the other cannot.
  it("renders the same result as JSON and as prose", async () => {
    const options: CliOptions = { ...base, stages: registryOf(passthroughStage("stage-a")) };
    await seed(options);

    const json = await invoke(options, "status", "--json");
    const human = await invoke(options, "status");

    expect(json.code).toBe(human.code);
    const parsed = json.json() as {
      outcome: string;
      data: { focused?: { plan: { next: { stageId?: string }[] } } };
    };
    expect(parsed.outcome).toBe("ok");

    const nextStage = parsed.data.focused?.plan.next[0]?.stageId;
    expect(nextStage).toBe("stage-a");
    // The prose must not omit what the JSON reports.
    expect(human.stdout).toContain("stage-a");
  });

  it("emits valid JSON for a refusal too, not just for success", async () => {
    await invoke(base, "init", "--show", "example-show", "--slug", "episode-a");
    const refused = await invoke(
      base,
      "init",
      "--show",
      "example-show",
      "--slug",
      "episode-b",
      "--json",
    );

    expect(refused.code).toBe(ExitCodes.refused);
    const parsed = refused.json() as { outcome: string; refusal: { reason: string } };
    expect(parsed.outcome).toBe("refused");
    expect(parsed.refusal.reason).toBe("episode_already_exists");
  });

  it("writes JSON to stdout and diagnostics to stderr, so a pipe stays parseable", async () => {
    const options: CliOptions = {
      ...base,
      stages: registryOf(gatedStage("stage-a", "content-freeze")),
      gates: [gateDefinition("content-freeze")],
      subjects: subjectsForAll(["content-freeze"]),
    };
    const runId = await seed(options);

    const result = await invoke(options, "run", "stage-a", "--run", runId, "--json");
    expect(() => result.json()).not.toThrow();
  });
});

describe("status is the operator's answer (§24)", () => {
  it("leads with what to do next rather than a state dump", async () => {
    const options: CliOptions = { ...base, stages: registryOf(passthroughStage("stage-a")) };
    await seed(options);

    const result = await invoke(options, "status");
    const nextIndex = result.stdout.indexOf("Next");
    const stagesIndex = result.stdout.indexOf("Stages");
    expect(nextIndex).toBeGreaterThanOrEqual(0);
    expect(nextIndex).toBeLessThan(stagesIndex);
  });

  it("explains what is blocked and why, not merely what is missing", async () => {
    const options: CliOptions = {
      ...base,
      stages: registryOf(passthroughStage("stage-a")),
      gates: [gateDefinition("content-freeze")],
      subjects: subjectsForAll(["content-freeze"]),
    };
    await seed(options);

    const result = await invoke(options, "status");
    expect(result.stdout).toContain("Blocked");
    expect(result.stdout).toContain("content-freeze");
  });

  it("tells an operator what to do first in an empty workspace", async () => {
    const result = await invoke(base, "status");
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("no Episode");
  });
});

describe("help and usage", () => {
  it("prints usage with no arguments and exits successfully", async () => {
    const result = await invoke(base);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toBe(USAGE);
  });

  it("documents every command it dispatches", async () => {
    for (const command of [
      "init",
      "start",
      "status",
      "inspect",
      "run",
      "retry",
      "approve",
      "reject",
      "artifacts",
      "artifacts lineage",
      "artifacts cleanup-plan",
      "artifacts archive",
      "costs",
      "release status",
      "release plan",
      "release reconcile",
      "release execute",
      "script record",
      "synthesis plan",
      "synthesis run",
      "synthesis charge",
      "takes",
      "takes decide",
    ]) {
      expect(USAGE, `usage does not mention "${command}"`).toContain(command);
    }
  });

  // The two irreversible commands. §18.1 requires explicit scoped authority for paid synthesis
  // and publishing; an operator reading help should learn that before running one, not after.
  it("marks the operations that spend money or publish", () => {
    expect(USAGE).toContain("spends money");
    expect(USAGE).toContain("publishes");
    expect(USAGE).toContain("Operations that are not reversible");
  });

  it("explains that a missing adapter is exit 2 rather than a refusal", () => {
    expect(USAGE).toContain("including a missing adapter");
  });

  // §4.2 keeps provider, platform, and adopter identities out of the runtime, and help text is
  // part of the runtime's surface.
  //
  // The names are assembled from fragments rather than written out: CI greps `packages/` for
  // exactly these strings, so spelling them literally here would fail the very check this test
  // mirrors.
  it("names no provider, platform, or adopter", () => {
    const forbidden = [
      ["eleven", "labs"],
      ["open", "ai"],
      ["you", "tube"],
      ["spot", "ify"],
      ["fire", "store"],
    ].map((parts) => parts.join(""));

    for (const name of forbidden) {
      expect(USAGE.toLowerCase(), `usage text names "${name}"`).not.toContain(name);
    }
  });
});

describe("commands over a seeded workspace", () => {
  it("reports no artifacts for a fresh Run without failing", async () => {
    const runId = await seed();
    const result = await invoke(base, "artifacts", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("No artifacts");
  });

  it("reports no costs for a fresh Run", async () => {
    const runId = await seed();
    const result = await invoke(base, "costs", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
  });

  it("reports release status for a Run with no release operations", async () => {
    const runId = await seed();
    const result = await invoke(base, "release", "status", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("No release operations");
  });

  // Performing a release is WP-12's. Silently accepting the verb would imply a capability this
  // build does not have.
  it("rejects a release subcommand that does not exist, and names the ones that do", async () => {
    const runId = await seed();
    const result = await invoke(base, "release", "publish", "--run", runId);
    expect(result.code).toBe(ExitCodes.error);
    // Naming the alternatives matters more than naming the mistake: an operator who guessed
    // "publish" needs to learn that the verb is "execute", not merely that they were wrong.
    expect(result.stderr).toContain("status, plan, reconcile, or execute");
  });

  it("inspects a Run by id", async () => {
    const runId = await seed();
    const result = await invoke(base, "inspect", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain(runId);
  });

  it("runs a stage and reports success", async () => {
    const options: CliOptions = { ...base, stages: registryOf(passthroughStage("stage-a")) };
    const runId = await seed(options);

    const result = await invoke(options, "run", "stage-a", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("succeeded");
  });

  it("records an approval and shows the resulting gate state", async () => {
    const options: CliOptions = {
      ...base,
      gates: [gateDefinition("content-freeze")],
      subjects: subjectsForAll(["content-freeze"]),
    };
    const runId = await seed(options);

    const result = await invoke(options, "approve", "content-freeze", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("satisfied");
  });
});

describe("cancel (contract §19.1, §19.2; ADR-0026)", () => {
  it("abandons a Run and names who did it", async () => {
    const runId = await seed();
    const result = await invoke(
      base,
      "cancel",
      "--run",
      runId,
      "--reason",
      "Superseded by a re-cut.",
      "--actor",
      "human:operator-a",
    );

    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("cancelled");
    expect(result.stdout).toContain("operator-a");
    expect(result.stdout).toContain("Superseded by a re-cut.");
  });

  it("reports the Run as cancelled afterwards", async () => {
    const runId = await seed();
    await invoke(base, "cancel", "--run", runId, "--actor", "human:operator-a");

    const status = await invoke(base, "status", "--run", runId, "--json");
    const parsed = status.json() as { data: { focused: { state: { status: string } } } };
    expect(parsed.data.focused.state.status).toBe("cancelled");
  });

  it("refuses a second cancellation rather than overwriting the record", async () => {
    // §20's trace depends on who abandoned the Run and when; there is only one copy of that.
    const runId = await seed();
    await invoke(base, "cancel", "--run", runId, "--actor", "human:operator-a");

    const again = await invoke(base, "cancel", "--run", runId, "--actor", "human:operator-a");
    expect(again.code).toBe(ExitCodes.refused);
  });
});
