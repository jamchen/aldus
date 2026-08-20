/**
 * The workspace a config module sees (ADR-0029).
 *
 * The defect these pin: the CLI resolved the workspace as `--workspace` → `ALDUS_WORKSPACE` →
 * cwd, but loaded the config module *before* per-command flags were parsed — so a config could
 * observe only the last two links of that chain. A config deriving anything from the workspace
 * therefore configured a different workspace than the command acted on, and the failure surfaced
 * as `ALDUS_STAGE_NOT_REGISTERED`: an error pointing at a stage list that was correct and
 * complete, two layers from the fault.
 *
 * Every identifier is fictional (§4.2, §19.2).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initWorkspace } from "@aldus-runtime/file-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { run, type CliEnvironment } from "../src/cli.js";
import { ExitCodes, type ExitCode } from "../src/exit.js";

let acted: string;
let elsewhere: string;
let savedWorkspaceEnv: string | undefined;
let counter = 0;

beforeEach(async () => {
  // `bindWorkspace` writes the resolved workspace into the real process environment, so a config
  // module imported into this process can read it. That is the fix; it also leaks between tests
  // in a way a real CLI process never experiences, so it is saved and restored here.
  savedWorkspaceEnv = process.env["ALDUS_WORKSPACE"];
  acted = await mkdtemp(join(tmpdir(), "aldus-acted-"));
  elsewhere = await mkdtemp(join(tmpdir(), "aldus-elsewhere-"));
  await initWorkspace(acted);
  await initWorkspace(elsewhere);
});

afterEach(async () => {
  if (savedWorkspaceEnv === undefined) delete process.env["ALDUS_WORKSPACE"];
  else process.env["ALDUS_WORKSPACE"] = savedWorkspaceEnv;
  await rm(acted, { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

interface Result {
  code: ExitCode;
  stdout: string;
  stderr: string;
}

/**
 * Invoke the CLI with no `ALDUS_WORKSPACE` and a cwd that is *not* the workspace under test.
 *
 * Both are deliberate. The env var is the link that used to mask the defect, and a cwd equal to
 * the workspace would let a config reading the wrong value still look right.
 */
async function invoke(argv: readonly string[], env: Record<string, string> = {}): Promise<Result> {
  const out: string[] = [];
  const err: string[] = [];
  const environment: CliEnvironment = {
    argv,
    env,
    cwd: elsewhere,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    subjects: () => Promise.resolve({}),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  };
  const code = await run(environment);
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

/**
 * A config module written as plain JavaScript with no imports.
 *
 * `read` reports the workspace the module was handed. A file rather than a shared variable
 * because `import()` caches by URL: the module body runs once, while a factory is called on every
 * invocation, and a file records what the *factory* saw rather than what the first import did.
 */
async function writeConfig(
  body: string,
): Promise<{ path: string; read(): Promise<string | undefined> }> {
  counter += 1;
  const observed = join(elsewhere, `observed-${counter}.json`);
  const path = join(elsewhere, `config-${counter}.mjs`);
  await writeFile(
    path,
    [
      'import { writeFileSync } from "node:fs";',
      `const OBSERVED = ${JSON.stringify(observed)};`,
      "const stageFor = (workspace) => ({",
      "  id: workspace.split('/').pop(),",
      '  version: "1",',
      "  artifacts: { produces: 'none' },",
      "  retrySafety: { kind: 'idempotent' },",
      "  requiredCapabilities: [],",
      "  inputSchema: { safeParse: (value) => ({ success: true, data: value }) },",
      "  outputSchema: { safeParse: (value) => ({ success: true, data: value }) },",
      '  execute: () => ({ status: "succeeded", output: {} }),',
      "});",
      body,
    ].join("\n"),
    "utf8",
  );
  return {
    path,
    read: async () => {
      try {
        return JSON.parse(await readFile(observed, "utf8")) as string;
      } catch {
        return undefined;
      }
    },
  };
}

/** A factory config: records the workspace it was given, and registers a stage named after it. */
function factoryBody(): string {
  return [
    "export default ({ workspace }) => {",
    "  writeFileSync(OBSERVED, JSON.stringify(workspace));",
    "  return { stages: [stageFor(workspace)] };",
    "};",
  ].join("\n");
}

describe("a config module sees the workspace the command acts on", () => {
  // The regression, written as the adopter reported it: two invocations naming the same
  // workspace by different means must configure the same workspace.
  it("hands a factory config the workspace resolved from --workspace", async () => {
    const config = await writeConfig(factoryBody());

    const result = await invoke(["status", "--workspace", acted, "--config", config.path]);

    expect(result.code).toBe(ExitCodes.success);
    expect(await config.read()).toBe(acted);
  });

  it("reaches the same answer whether --workspace or ALDUS_WORKSPACE named it", async () => {
    const viaFlag = await writeConfig(factoryBody());
    const viaEnv = await writeConfig(factoryBody());

    const flagged = await invoke(["status", "--workspace", acted, "--config", viaFlag.path]);
    const exported = await invoke(["status", "--config", viaEnv.path], {
      ALDUS_WORKSPACE: acted,
    });

    expect(flagged.code).toBe(exported.code);
    expect(await viaFlag.read()).toBe(acted);
    expect(await viaEnv.read()).toBe(acted);
  });

  it("does not fall back to the cwd when --workspace was given", async () => {
    const config = await writeConfig(factoryBody());

    await invoke(["status", "--workspace", acted, "--config", config.path]);

    // The whole defect in one assertion: `elsewhere` is the cwd, and configuring it would mean
    // the command and the config disagreed about which workspace was in play.
    expect(await config.read()).not.toBe(elsewhere);
  });

  it("still accepts a config exported as a plain object", async () => {
    const config = await writeConfig(
      [
        "writeFileSync(OBSERVED, JSON.stringify('object-form'));",
        "export default { stages: [] };",
      ].join("\n"),
    );

    const result = await invoke(["status", "--workspace", acted, "--config", config.path]);

    expect(result.code).toBe(ExitCodes.success);
    expect(await config.read()).toBe("object-form");
  });

  it("lets a config read process.env.ALDUS_WORKSPACE and see the --workspace value", async () => {
    // Configs written against 0.1.0 read the environment variable. They keep working, and now
    // agree with `--workspace` rather than contradicting it.
    const config = await writeConfig(
      [
        "export default () => {",
        "  writeFileSync(OBSERVED, JSON.stringify(process.env.ALDUS_WORKSPACE));",
        "  return { stages: [] };",
        "};",
      ].join("\n"),
    );

    await invoke(["status", "--workspace", acted, "--config", config.path]);

    expect(await config.read()).toBe(acted);
  });

  it("attributes a throwing factory to the module, naming the workspace it was building for", async () => {
    const config = await writeConfig(
      ["export default () => {", '  throw new Error("no episode here");', "};"].join("\n"),
    );

    const result = await invoke(["status", "--workspace", acted, "--config", config.path]);

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("ALDUS_CONFIG_UNREADABLE");
    expect(result.stderr).toContain("no episode here");
    expect(result.stderr).toContain(acted);
  });
});

describe("--workspace before or after the command", () => {
  it("accepts it before the subcommand", async () => {
    const config = await writeConfig(factoryBody());

    const result = await invoke(["--workspace", acted, "status", "--config", config.path]);

    expect(result.code).toBe(ExitCodes.success);
    expect(await config.read()).toBe(acted);
  });

  it("accepts it after the subcommand", async () => {
    const config = await writeConfig(factoryBody());

    const result = await invoke(["status", "--workspace", acted, "--config", config.path]);

    expect(result.code).toBe(ExitCodes.success);
    expect(await config.read()).toBe(acted);
  });

  it("accepts --config before the subcommand too", async () => {
    const config = await writeConfig(factoryBody());

    const result = await invoke(["--config", config.path, "--workspace", acted, "status"]);

    expect(result.code).toBe(ExitCodes.success);
    expect(await config.read()).toBe(acted);
  });

  it("refuses a leading --workspace with no value rather than eating the command", async () => {
    const result = await invoke(["--workspace", "--json", "status"]);

    expect(result.code).toBe(ExitCodes.error);
    expect(result.stderr).toContain("--workspace needs a path");
  });
});

describe("errors name the workspace that was in effect", () => {
  it("distinguishes an empty registry from a stage that is merely missing", async () => {
    const empty = await writeConfig("export default { stages: [] };");

    const missing = await invoke([
      "run",
      "absent-stage",
      "--run",
      "run-a",
      "--workspace",
      acted,
      "--config",
      empty.path,
    ]);

    // "No stage is registered with id X" reads as a typo. Nothing being registered at all is a
    // configuration problem, and saying so removes the misdirection.
    expect(missing.stderr).toContain("ALDUS_NO_STAGES_CONFIGURED");
    expect(missing.stderr).toContain("No stages are registered at all");
  });

  it("names the workspace and config when nothing is registered", async () => {
    const empty = await writeConfig("export default { stages: [] };");

    const result = await invoke([
      "run",
      "absent-stage",
      "--run",
      "run-a",
      "--workspace",
      acted,
      "--config",
      empty.path,
    ]);

    expect(result.stderr).toContain(acted);
    expect(result.stderr).toContain(empty.path);
  });

  it("reports a genuinely missing stage differently from an unconfigured one", async () => {
    // A factory config registers a stage named after the workspace, so this registry is
    // populated — and a different id must therefore fail as a lookup, not as configuration.
    const config = await writeConfig(factoryBody());

    const result = await invoke([
      "run",
      "not-that-stage",
      "--run",
      "run-a",
      "--workspace",
      acted,
      "--config",
      config.path,
    ]);

    expect(result.stderr).not.toContain("ALDUS_NO_STAGES_CONFIGURED");
  });
});
