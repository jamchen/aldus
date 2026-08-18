/**
 * The CLI over the composed services (issue #27 item 4).
 *
 * These cover what the adapter is responsible for once the artifact registry, the release
 * executor, and the TTS ledger are reachable: routing a subcommand to one service call, reading
 * the documents those calls take, and mapping the answer to an exit code.
 *
 * Whether an operation is *allowed* is `@aldus-runtime/services`' business and is tested there.
 * The exception is the pair of irreversible commands — for those, this file asserts the adapter
 * was **never reached**, because an exit code alone cannot prove no money was spent.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { RecordingReleaseAdapter } from "@aldus-runtime/release";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExitCodes } from "../src/exit.js";

import {
  aBundle,
  aPlan,
  aScript,
  DESTINATION_A,
  gateDefinition,
  invoke,
  makeTempWorkspace,
  passthroughStage,
  RecordingSynthesisAdapter,
  registryOf,
  writeDocument,
  type CliOptions,
  type Invocation,
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

/** Create an Episode and a Run, and report both identities. */
async function seed(options: CliOptions = base): Promise<{ runId: string; episodeId: string }> {
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
  const parsed = started.json() as {
    data: { run: { runId: string; episode: { episodeId: string } } };
  };
  return {
    runId: parsed.data.run.runId,
    episodeId: parsed.data.run.episode.episodeId,
  };
}

describe("artifacts subcommands (contract §8, §20)", () => {
  it("lists artifacts for a Run with none, without failing", async () => {
    const { runId } = await seed();
    const result = await invoke(base, "artifacts", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("No artifacts recorded");
  });

  it("keeps bare `artifacts` working, so §18's verb is unchanged", async () => {
    const { runId } = await seed();
    const listed = await invoke(base, "artifacts", "list", "--run", runId, "--json");
    const bare = await invoke(base, "artifacts", "--run", runId, "--json");
    expect(bare.code).toBe(listed.code);
    expect(bare.json()).toEqual(listed.json());
  });

  it("plans a cleanup without removing anything", async () => {
    const { runId } = await seed();
    const result = await invoke(base, "artifacts", "cleanup-plan", "--run", runId, "--json");
    expect(result.code).toBe(ExitCodes.success);
    const parsed = result.json() as { data: { safe: boolean; removable: unknown[] } };
    expect(parsed.data.safe).toBe(true);
  });

  it("reads a cleanup plan without an actor, so safety can be checked before identity", async () => {
    // §8.1 asks an operator to confirm archival before cleaning. Requiring an identity to *look*
    // would put configuration between an operator and the check that keeps them safe.
    const { runId } = await seed();
    const result = await invoke({ ...base, env: {} }, "artifacts", "cleanup-plan", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
  });

  it("refuses to archive without an actor (§19.2)", async () => {
    const { runId } = await seed();
    const result = await invoke({ ...base, env: {} }, "artifacts", "archive", "--run", runId);
    expect(result.code).toBe(ExitCodes.refused);
  });

  it("reports an unregistered artifact id rather than inventing a lineage", async () => {
    await seed();
    const result = await invoke(base, "artifacts", "lineage", "art_missing");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_ARTIFACT_NOT_REGISTERED");
  });

  it("names the valid subcommands when given one that is not", async () => {
    const { runId } = await seed();
    const result = await invoke(base, "artifacts", "purge", "--run", runId);
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("list, lineage, cleanup-plan, or archive");
  });
});

describe("release subcommands (contract §17, §13.4)", () => {
  it("reports a bundle's derived state", async () => {
    const { runId, episodeId } = await seed();
    const path = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const options = { ...base, releaseAdapters: [new RecordingReleaseAdapter(DESTINATION_A)] };

    const result = await invoke(options, "release", "plan", "--bundle", path, "--json");
    expect(result.code).toBe(ExitCodes.success);
    const parsed = result.json() as { data: { status: { state: string; remaining: string[] } } };
    expect(parsed.data.status.state).toBe("not_started");
    expect(parsed.data.status.remaining).toContain("upload");
  });

  it("performs nothing under --dry-run, and says so", async () => {
    const { runId, episodeId } = await seed();
    const path = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const adapter = new RecordingReleaseAdapter(DESTINATION_A);

    const result = await invoke(
      { ...base, releaseAdapters: [adapter] },
      "release",
      "execute",
      "--bundle",
      path,
      "--dry-run",
    );

    expect(result.code).toBe(ExitCodes.success);
    expect(result.stderr).toContain("Nothing was executed");
    // The claim that matters: a dry run reached no destination.
    expect(adapter.executed).toHaveLength(0);
  });

  it("executes a bundle and writes receipts", async () => {
    const { runId, episodeId } = await seed();
    const path = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const adapter = new RecordingReleaseAdapter(DESTINATION_A);

    const result = await invoke(
      { ...base, releaseAdapters: [adapter] },
      "release",
      "execute",
      "--bundle",
      path,
      "--json",
    );

    expect(result.code).toBe(ExitCodes.success);
    expect(adapter.executed).toHaveLength(1);
    const parsed = result.json() as { data: { outcome: { state: string } } };
    expect(parsed.data.outcome.state).toBe("succeeded");
  });

  it("refuses to execute without an actor (§19.2)", async () => {
    const { runId, episodeId } = await seed();
    const path = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const adapter = new RecordingReleaseAdapter(DESTINATION_A);

    const result = await invoke(
      { ...base, env: {}, releaseAdapters: [adapter] },
      "release",
      "execute",
      "--bundle",
      path,
    );

    expect(result.code).toBe(ExitCodes.refused);
    expect(adapter.executed).toHaveLength(0);
  });

  it("reports a missing adapter as an environment error, not a refusal", async () => {
    // ADAPTER_NOT_WIRED is thrown with a `policy` category but is a wiring error: no approval
    // makes an adapter appear, so exit 1 — "may reasonably wait and retry" — would mislead.
    const { runId, episodeId } = await seed();
    const path = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));

    const result = await invoke(base, "release", "execute", "--bundle", path);
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_ADAPTER_NOT_WIRED");
  });

  it("names the missing flag rather than failing obscurely", async () => {
    await seed();
    const result = await invoke(base, "release", "plan");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("--bundle");
  });

  it("reports an unreadable bundle as an invocation error", async () => {
    await seed();
    const result = await invoke(base, "release", "plan", "--bundle", "./absent.json");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_DOCUMENT_UNREADABLE");
  });

  it("reports a malformed bundle distinctly from a missing one", async () => {
    await seed();
    const path = join(temp.root, "broken.json");
    await writeFile(path, "{not json", "utf8");
    const result = await invoke(base, "release", "plan", "--bundle", path);
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_DOCUMENT_MALFORMED");
  });
});

describe("performance and synthesis (contract §14, §15, §13.2)", () => {
  it("records a PerformanceScript", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "script.json", aScript(runId));
    const result = await invoke(base, "script", "record", "--file", path);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("script-a");
  });

  it("records a plan, and says plainly that it authorizes nothing", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "plan.json", aPlan(runId));
    const result = await invoke(base, "synthesis", "plan", "--file", path);
    expect(result.code).toBe(ExitCodes.success);
    // The sentence is the point: a plan existing is not permission to spend against it.
    expect(result.stdout).toContain("authorizes nothing");
  });

  it("refuses unauthorized synthesis without ever reaching the adapter (§13.2)", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "plan.json", aPlan(runId));
    const adapter = new RecordingSynthesisAdapter();

    const result = await invoke(
      { ...base, synthesisAdapter: adapter },
      "synthesis",
      "run",
      "--plan",
      path,
      "--segment",
      "seg-1",
    );

    expect(result.code).toBe(ExitCodes.refused);
    // No gate was approved, so no money may be spent — and the only proof of that is that the
    // adapter was never called.
    expect(adapter.calls).toHaveLength(0);
  });

  it("explains the refusal rather than emitting a stack trace", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "plan.json", aPlan(runId));
    const result = await invoke(
      { ...base, synthesisAdapter: new RecordingSynthesisAdapter() },
      "synthesis",
      "run",
      "--plan",
      path,
      "--segment",
      "seg-1",
    );
    expect(result.stderr).toContain("Refused:");
    expect(result.stderr).not.toContain("    at ");
  });

  it("reports a missing synthesis adapter as an environment error", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "plan.json", aPlan(runId));
    const result = await invoke(base, "synthesis", "run", "--plan", path, "--segment", "seg-1");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_ADAPTER_NOT_WIRED");
  });

  it("refuses anonymous synthesis before considering anything else (§19.2)", async () => {
    const { runId } = await seed();
    const path = await writeDocument(temp.root, "plan.json", aPlan(runId));
    const adapter = new RecordingSynthesisAdapter();

    const result = await invoke(
      { ...base, env: {}, synthesisAdapter: adapter },
      "synthesis",
      "run",
      "--plan",
      path,
      "--segment",
      "seg-1",
    );

    expect(result.code).toBe(ExitCodes.refused);
    expect(adapter.calls).toHaveLength(0);
  });

  it("reports no takes for a Run with none", async () => {
    const { runId } = await seed();
    const result = await invoke(base, "takes", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("No takes recorded");
  });

  it("requires a decision value it recognises", async () => {
    const { runId } = await seed();
    const result = await invoke(
      base,
      "takes",
      "decide",
      "take-a",
      "--run",
      runId,
      "--decision",
      "maybe",
    );
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("accepted|rejected");
  });

  it("refuses to decide a take anonymously (§13.3, §19.2)", async () => {
    const { runId } = await seed();
    const result = await invoke(
      { ...base, env: {} },
      "takes",
      "decide",
      "take-a",
      "--run",
      runId,
      "--decision",
      "accepted",
    );
    expect(result.code).toBe(ExitCodes.refused);
    expect(result.stderr).toContain("ALDUS_ACTOR_REQUIRED");
  });
});

describe("config module (ADR-0019)", () => {
  /**
   * A config module written as plain JavaScript with no imports.
   *
   * Deliberately not importing `@aldus-runtime/release`: an adapter only has to satisfy the
   * `ReleaseAdapter` shape, and writing one from scratch here proves the injection point is a
   * genuine contract rather than a way to pass Aldus's own test double back to itself.
   */
  async function writeConfig(name: string, destination: string): Promise<string> {
    const path = join(temp.root, name);
    await writeFile(
      path,
      [
        "const adapter = {",
        `  destination: ${JSON.stringify(destination)},`,
        "  executed: [],",
        "  async execute(request) {",
        "    this.executed.push(request);",
        '    return { status: "succeeded", remoteId: "remote-a" };',
        "  },",
        "  async lookup() {",
        "    return { present: false };",
        "  },",
        "};",
        "export default { releaseAdapters: [adapter] };",
        "export const adapterForTest = adapter;",
      ].join("\n"),
      "utf8",
    );
    return path;
  }

  it("takes adapters from the module an operator points at", async () => {
    const { runId, episodeId } = await seed();
    const bundlePath = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const configPath = await writeConfig("aldus.config.mjs", DESTINATION_A);

    const result = await invoke(
      base,
      "release",
      "execute",
      "--bundle",
      bundlePath,
      "--config",
      configPath,
      "--json",
    );

    expect(result.code).toBe(ExitCodes.success);
    const parsed = result.json() as { data: { outcome: { state: string } } };
    expect(parsed.data.outcome.state).toBe("succeeded");
  });

  it("reads the module named by the environment when no flag is given", async () => {
    const { runId, episodeId } = await seed();
    const bundlePath = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const configPath = await writeConfig("env.config.mjs", DESTINATION_A);

    const result = await invoke(
      { ...base, env: { ALDUS_ACTOR: "human:operator-a", ALDUS_CONFIG: configPath } },
      "release",
      "execute",
      "--bundle",
      bundlePath,
    );

    expect(result.code).toBe(ExitCodes.success);
  });

  it("reports an unloadable config module as an environment error", async () => {
    await seed();
    const result = await invoke(base, "status", "--config", "./absent.config.mjs");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_CONFIG_UNREADABLE");
  });

  it("reports a config module that exports nothing usable", async () => {
    await seed();
    const configPath = join(temp.root, "empty.config.mjs");
    await writeFile(configPath, "export const other = 1;\n", "utf8");
    const result = await invoke(base, "status", "--config", configPath);
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_CONFIG_INVALID");
  });

  it("rejects --config with no value rather than treating the next flag as a path", async () => {
    await seed();
    const result = await invoke(base, "status", "--config", "--json");
    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("needs a module path");
  });

  it("needs no config for the commands that need nothing wired (§24)", async () => {
    const { runId } = await seed();
    const result = await invoke({ ...base, env: {} }, "status", "--run", runId);
    expect(result.code).toBe(ExitCodes.success);
  });

  it("lets an injected adapter win over the configured one, so a test is never overridden", async () => {
    const { runId, episodeId } = await seed();
    const bundlePath = await writeDocument(temp.root, "bundle.json", aBundle(runId, episodeId));
    const injected = new RecordingReleaseAdapter(DESTINATION_A);
    // The config names a destination the bundle does not use, so if config won, the execution
    // would fail for want of an adapter rather than quietly succeeding.
    const configPath = await writeConfig("other.config.mjs", "destination-b");

    const result = await invoke(
      { ...base, releaseAdapters: [injected] },
      "release",
      "execute",
      "--bundle",
      bundlePath,
      "--config",
      configPath,
    );

    expect(result.code).toBe(ExitCodes.success);
    expect(injected.executed).toHaveLength(1);
  });
});

describe("output modes over the composed surface (§18)", () => {
  it("renders the same result as JSON and as prose", async () => {
    const { runId } = await seed();
    const prose = await invoke(base, "artifacts", "--run", runId);
    const json = await invoke(base, "artifacts", "--run", runId, "--json");

    expect(prose.code).toBe(json.code);
    const parsed = json.json() as { outcome: string; data: { runId: string } };
    expect(parsed.outcome).toBe("ok");
    expect(parsed.data.runId).toBe(runId);
  });

  it("keeps stdout parseable when a refusal is rendered", async () => {
    const { runId } = await seed();
    const result = await invoke(
      { ...base, env: {} },
      "artifacts",
      "archive",
      "--run",
      runId,
      "--json",
    );
    expect(() => result.json()).not.toThrow();
    const parsed = result.json() as { outcome: string };
    expect(parsed.outcome).toBe("refused");
  });
});

describe("workspace state", () => {
  it("writes nothing outside the workspace root", async () => {
    // A CLI that resolved a relative path against the wrong base would scatter state; the
    // workspace binding §19.2 requires has to hold for the new commands too.
    const { runId } = await seed();
    await invoke(base, "artifacts", "cleanup-plan", "--run", runId);
    const episode = await readFile(join(temp.root, ".aldus", "episode.json"), "utf8");
    expect(episode).toContain("example-show");
  });
});

describe("workflow graph from the config module (#46, contract §11, ADR-0021)", () => {
  /**
   * A config module exporting only a workflow graph, written as plain JavaScript.
   *
   * Nothing is imported: a graph is data, and writing one from scratch proves the config field
   * is a genuine contract rather than a way to hand Aldus back a value it constructed itself.
   */
  async function writeWorkflowConfig(name: string, body: string): Promise<string> {
    const path = join(temp.root, name);
    await writeFile(path, body, "utf8");
    return path;
  }

  /** A Run with two stages and one unsatisfied blocking gate. */
  async function seedGated(): Promise<{ runId: string; options: CliOptions }> {
    const options: CliOptions = {
      ...base,
      stages: registryOf(passthroughStage("stage-a"), passthroughStage("stage-b")),
      gates: [gateDefinition("gate-a")],
      // No subjects supplied, so `gate-a` reads as pending rather than satisfied (§13.2).
      subjects: {},
    };
    const { runId } = await seed(options);
    return { runId, options };
  }

  /** Stage ids the plan currently offers as next actions. */
  function offeredStages(result: Invocation): string[] {
    const parsed = result.json() as {
      data: { focused?: { plan: { next: { stageId?: string }[] } } };
    };
    return (parsed.data.focused?.plan.next ?? [])
      .map((action) => action.stageId)
      .filter((id): id is string => id !== undefined);
  }

  it("reaches the context and changes what status offers", async () => {
    // The end-to-end point of #46: everything ADR-0021 enables was available programmatically
    // and unreachable from the binary.
    const { runId, options } = await seedGated();

    const withoutGraph = await invoke(options, "status", "--run", runId, "--json");
    expect(withoutGraph.code).toBe(ExitCodes.success);
    // Conservative fallback: nothing is declared, so an unsatisfied gate blocks every stage.
    expect(offeredStages(withoutGraph)).toEqual([]);

    const configPath = await writeWorkflowConfig(
      "workflow.config.mjs",
      [
        "export default {",
        "  workflow: {",
        '    workflowId: "workflow-a",',
        "    stages: [",
        '      { stageId: "stage-a", requiredGates: ["gate-a"] },',
        '      { stageId: "stage-b", requiredGates: [] },',
        "    ],",
        "  },",
        "};",
      ].join("\n"),
    );

    const withGraph = await invoke(
      options,
      "status",
      "--run",
      runId,
      "--config",
      configPath,
      "--json",
    );

    expect(withGraph.code).toBe(ExitCodes.success);
    // stage-b declares it needs no gate, so the pending gate no longer suppresses it. stage-a
    // still requires gate-a and stays blocked.
    expect(offeredStages(withGraph)).toContain("stage-b");
    expect(offeredStages(withGraph)).not.toContain("stage-a");
  });

  it("leaves behaviour unchanged when a config supplies no graph", async () => {
    const { runId, options } = await seedGated();
    const configPath = await writeWorkflowConfig(
      "empty.config.mjs",
      "export default { gates: [] };\n",
    );

    const withConfig = await invoke(
      options,
      "status",
      "--run",
      runId,
      "--config",
      configPath,
      "--json",
    );
    const withoutConfig = await invoke(options, "status", "--run", runId, "--json");

    expect(withConfig.code).toBe(withoutConfig.code);
    expect(offeredStages(withConfig)).toEqual(offeredStages(withoutConfig));
  });

  it("refuses a config key it does not recognise, naming the key", async () => {
    // The expensive half of #46: `workflow` used to load cleanly and be dropped, so the symptom
    // appeared as a wrong next action rather than as a wiring error.
    await seed();
    const configPath = await writeWorkflowConfig(
      "typo.config.mjs",
      "export default { wrokflow: { stages: [] } };\n",
    );

    const result = await invoke(base, "status", "--config", configPath);

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_CONFIG_UNKNOWN_KEY");
    expect(result.stderr).toContain("wrokflow");
    // And it says what is accepted, so the fix does not need the source.
    expect(result.stderr).toContain("workflow");
  });

  it("names the offending stage when the graph is malformed", async () => {
    await seed();
    const configPath = await writeWorkflowConfig(
      "malformed.config.mjs",
      [
        "export default {",
        "  workflow: {",
        "    stages: [",
        '      { stageId: "stage-a" },',
        '      { stageId: "stage-b", requiredGates: "gate-a" },',
        "    ],",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await invoke(base, "status", "--config", configPath);

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_CONFIG_INVALID");
    expect(result.stderr).toContain("stage-b");
    expect(result.stderr).toContain("requiredGates");
  });

  it("refuses a stage declared twice, rather than silently taking the first", async () => {
    await seed();
    const configPath = await writeWorkflowConfig(
      "duplicate.config.mjs",
      [
        "export default {",
        "  workflow: {",
        "    stages: [",
        '      { stageId: "stage-a", requiredGates: ["gate-a"] },',
        '      { stageId: "stage-a", requiredGates: [] },',
        "    ],",
        "  },",
        "};",
      ].join("\n"),
    );

    const result = await invoke(base, "status", "--config", configPath);

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("stage-a");
  });
});

describe("init flag grouping (#46 follow-on)", () => {
  it("refuses --episode-id without --show, naming what is missing", async () => {
    // Previously this created the workspace and quietly no Episode: `InitRequest.episode`
    // requires a showId, so every other Episode flag was dropped.
    const result = await invoke(base, "init", "--episode-id", "show:example-show:episode:a");

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("--episode-id");
    expect(result.stderr).toContain("--show");
  });

  it("names every Episode flag supplied without --show", async () => {
    const result = await invoke(base, "init", "--slug", "episode-a", "--title", "An Episode");

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("--slug");
    expect(result.stderr).toContain("--title");
  });

  it("still initialises the workspace alone when no Episode flag is given", async () => {
    const result = await invoke(base, "init");

    expect(result.code).toBe(ExitCodes.success);
    // Stated, not implied by an absent line — the two outcomes must not look alike.
    expect(result.stdout).toContain("No Episode created");
  });

  it("creates the Episode and says so when --show is given", async () => {
    const result = await invoke(base, "init", "--show", "example-show", "--slug", "episode-a");

    expect(result.code).toBe(ExitCodes.success);
    expect(result.stdout).toContain("Episode:");
    expect(result.stdout).not.toContain("No Episode created");
  });

  it("accepts --episode-id alongside --show", async () => {
    const result = await invoke(
      base,
      "init",
      "--show",
      "example-show",
      "--episode-id",
      "show:example-show:episode:episode-a",
      "--json",
    );

    expect(result.code).toBe(ExitCodes.success);
    const parsed = result.json() as { data: { episode?: { episodeId: string } } };
    expect(parsed.data.episode?.episodeId).toBe("show:example-show:episode:episode-a");
  });
});
