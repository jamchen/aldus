import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CliOptions, TempWorkspace } from "./helpers.js";
import { invoke, makeTempWorkspace } from "./helpers.js";

/**
 * `--force` on `run` and `retry` (#244).
 *
 * The first adopter's dispatch was killed by a harness timeout, the record kept `status: "running"`,
 * and `retry` refused with *"pass `force` to take over"*. They read that as naming a capability the
 * CLI does not expose and filed it as unreachable.
 *
 * **It is reachable — the flag exists and has for many releases.** What was true is that the message
 * named the runner's *parameter* rather than the operator's *flag*, and a remedy someone cannot act
 * on from the text they are handed is the same defect as a missing one, one step earlier.
 *
 * These pin the flag's existence, because a message can be fixed and a flag can be removed, and the
 * message is now a promise about the CLI.
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

describe("the takeover flag the refusal names is the flag the CLI has", () => {
  it("accepts --force on retry", async () => {
    const result = await invoke(base, "retry", "some.stage", "--run", "run-a", "--force");

    // It fails for an unrelated reason — no stages are configured in a bare workspace — and that is
    // the point: parsing got past the flag. An unknown flag never reaches here.
    expect(result.stderr).not.toContain("Unknown option");
    expect(result.stderr).toContain("No stages are registered");
  });

  it("accepts --force on run", async () => {
    const result = await invoke(base, "run", "some.stage", "--run", "run-a", "--force");

    expect(result.stderr).not.toContain("Unknown option");
    expect(result.stderr).toContain("No stages are registered");
  });

  it("rejects a flag that does not exist, so the two cases above mean something", async () => {
    // The control, and the whole reason the assertions above are worth writing. Without it,
    // "--force was not rejected" would also be true of a parser that ignores every unknown flag —
    // an assertion that is equally true when the mechanism is absent.
    const result = await invoke(base, "retry", "some.stage", "--run", "run-a", "--not-a-flag");

    expect(result.stderr).toContain("Unknown option");
  });
});
