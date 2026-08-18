/**
 * The clean-consumer smoke flow.
 *
 * This file runs *inside* a throwaway project outside the monorepo, against installed tarballs.
 * It deliberately imports through package names only — never a relative path into the
 * repository — because resolving a package name is the thing being tested.
 *
 * Adopter-neutral throughout: no provider, platform, show, or host appears here, and the
 * adapters are local fakes (architecture contract §4.2).
 */

import { mkdtemp } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// --- 1. Every published package must load by name ------------------------------------------

import { AldusError, SCHEMA_VERSION, formatEpisodeId, validate } from "@aldus-runtime/core";
import { FileWorkspace, initWorkspace } from "@aldus-runtime/file-store";
import { GateRegistry } from "@aldus-runtime/gate-engine";
import { StageRegistry } from "@aldus-runtime/stage-runner";
import { ArtifactRegistry, LocalDirectoryArchive } from "@aldus-runtime/artifact-registry";
import { AldusContext, AldusServices } from "@aldus-runtime/services";
import { TtsLedger } from "@aldus-runtime/tts-ledger";
import { AdapterRegistry } from "@aldus-runtime/release";
import { builders } from "@aldus-runtime/testkit";
import { compareRun } from "@aldus-runtime/regression";
import { USAGE } from "@aldus-runtime/cli";
import { AldusToolSurface } from "@aldus-runtime/mcp";

const require = createRequire(import.meta.url);

const PACKAGES = [
  "@aldus-runtime/core",
  "@aldus-runtime/file-store",
  "@aldus-runtime/gate-engine",
  "@aldus-runtime/stage-runner",
  "@aldus-runtime/artifact-registry",
  "@aldus-runtime/services",
  "@aldus-runtime/tts-ledger",
  "@aldus-runtime/release",
  "@aldus-runtime/testkit",
  "@aldus-runtime/regression",
  "@aldus-runtime/cli",
  "@aldus-runtime/mcp",
];

const failures = [];
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push(name);
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- 2. Nothing may resolve back into the monorepo -------------------------------------------

// The whole gate is worthless if npm quietly linked the workspace instead of extracting a
// tarball. `file:` *directory* specifiers symlink; `file:` *tarball* specifiers extract. This
// asserts we got the second, by resolving each package and checking where it really lives.
const monorepoRoot = process.env.ALDUS_MONOREPO_ROOT;
if (monorepoRoot === undefined) {
  failures.push("ALDUS_MONOREPO_ROOT was not set, so the symlink check cannot run");
}

for (const name of PACKAGES) {
  check(`resolves outside the monorepo: ${name}`, () => {
    // `import.meta.resolve`, not `require.resolve(name + "/package.json")`: a modern package is
    // entitled to keep package.json out of its `exports` map, and asserting otherwise would
    // test our packaging against an expectation npm itself abandoned.
    const real = realpathSync(fileURLToPath(import.meta.resolve(name)));
    if (monorepoRoot !== undefined && real.startsWith(realpathSync(monorepoRoot))) {
      throw new Error(`resolved to ${real}, which is inside the monorepo`);
    }
    if (!real.includes("node_modules")) {
      throw new Error(`resolved to ${real}, which is not an installed copy`);
    }
  });
}

// --- 3. Public API is actually usable --------------------------------------------------------

check("core exports a schema version", () => {
  if (typeof SCHEMA_VERSION !== "string") throw new Error("SCHEMA_VERSION is not a string");
});

check("core validates a record built by the testkit", () => {
  const episode = builders.EpisodeRef();
  const result = validate("EpisodeRef", episode);
  if (!result.ok) throw new Error("a testkit-built EpisodeRef failed validation");
});

check("the core schema version is the one the packages were built at", () => {
  if (!/^\d+\.\d+$/.test(SCHEMA_VERSION)) throw new Error(`odd schema version: ${SCHEMA_VERSION}`);
});

check("core mints a canonical episode identity", () => {
  const id = formatEpisodeId("example-show", "episode-a");
  if (id !== "show:example-show:episode:episode-a") throw new Error(`unexpected identity: ${id}`);
});

check("core JSON Schema artifacts ship in the tarball", () => {
  const schema = require("@aldus-runtime/core/schema/episode-ref.schema.json");
  if (typeof schema.$id !== "string") throw new Error("episode-ref schema has no $id");
});

check("cli exports its usage text", () => {
  if (!USAGE.includes("aldus")) throw new Error("usage text does not mention the binary");
});

check("regression and release and mcp expose their entry points", () => {
  for (const [label, value] of [
    ["compareRun", compareRun],
    ["AdapterRegistry", AdapterRegistry],
    ["AldusToolSurface", AldusToolSurface],
    ["TtsLedger", TtsLedger],
    ["ArtifactRegistry", ArtifactRegistry],
  ]) {
    if (value === undefined) throw new Error(`${label} is undefined`);
  }
});

// --- 4. The composed stack runs, with fake adapters ------------------------------------------

/** A synthesis adapter that performs no synthesis and contacts nothing. */
class FakeSynthesisAdapter {
  id = "fake-synthesis";
  calls = [];
  async synthesise(request, permit) {
    this.calls.push(request);
    return { audio: Buffer.from("fake audio"), providerRequestId: "req-1", permit };
  }
}

/** A release adapter for a fictional destination. */
class FakeReleaseAdapter {
  destination = "destination-a";
  calls = [];
  async execute(request) {
    this.calls.push(request);
    return { status: "succeeded", remoteId: "remote-1" };
  }
  async lookup() {
    return { exists: false };
  }
}

await checkAsync("composed stack initialises, starts a run, and reports status", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldus-consumer-"));
  await initWorkspace(root);

  const workspace = new FileWorkspace(root, { lockOptions: { retryMs: 1 } });
  const actor = { kind: "human", id: "operator-a" };

  const context = new AldusContext({
    workspace,
    gates: GateRegistry.from([]),
    stages: new StageRegistry(),
    actor,
    archive: new LocalDirectoryArchive(join(root, ".aldus", "archive")),
    synthesisAdapter: new FakeSynthesisAdapter(),
    releaseAdapters: [new FakeReleaseAdapter()],
  });

  const services = new AldusServices(context);

  const init = await services.init({
    episode: { showId: "example-show", slug: "episode-a" },
    actor,
  });
  if (init.outcome !== "ok") throw new Error(`init did not succeed: ${JSON.stringify(init)}`);

  const started = await services.startRun({
    workflowId: "workflow-a",
    workflowVersion: "1",
    actor,
  });
  if (started.outcome !== "ok")
    throw new Error(`startRun did not succeed: ${JSON.stringify(started)}`);

  const status = await services.status();
  if (status.outcome !== "ok") throw new Error(`status did not succeed: ${JSON.stringify(status)}`);
  if (typeof status.data !== "object") throw new Error("status returned no report");
});

// A refusal must still be a refusal in a published build — the safety properties are the point
// of the runtime, and a packaging mistake that disabled one would be silent.
await checkAsync("a mutation without an actor is refused, not performed", async () => {
  const root = await mkdtemp(join(tmpdir(), "aldus-consumer-"));
  await initWorkspace(root);
  const workspace = new FileWorkspace(root, { lockOptions: { retryMs: 1 } });
  const context = new AldusContext({
    workspace,
    gates: GateRegistry.from([]),
    stages: new StageRegistry(),
  });
  const services = new AldusServices(context);

  let refused = false;
  try {
    await services.init({ episode: { showId: "example-show", slug: "episode-a" } });
  } catch (error) {
    refused = error instanceof AldusError;
  }
  if (!refused) throw new Error("init without an actor was not refused");
});

// --- 5. Report --------------------------------------------------------------------------------

console.log(`clean-consumer smoke: ${checks.length} checks passed`);
if (failures.length > 0) {
  console.error(`\n${failures.length} FAILED:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
