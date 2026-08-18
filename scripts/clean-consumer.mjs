/**
 * The clean-consumer release gate.
 *
 * Packs the publish set into real tarballs, installs *only* those tarballs into a throwaway
 * project outside the monorepo, and proves the result is usable: every package imports by name,
 * declarations resolve under TypeScript, the `aldus` binary runs, and a composed stack drives a
 * workspace end to end with fake adapters.
 *
 * Why this exists rather than trusting the test suite: npm workspaces symlink every package into
 * the root `node_modules`, so a package can import something it never declared and the build,
 * the type checker, and every test still pass. `@aldus-runtime/cli` and `@aldus-runtime/mcp`
 * both shipped exactly that defect — three workspace packages declared only as
 * `devDependencies`, with the CLI constructing them at runtime. A consumer would have crashed on
 * first import. This gate installs what a consumer installs, so that class of defect fails here.
 *
 * Usage: node scripts/clean-consumer.mjs [--keep]
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { packAll } from "./pack.mjs";
import { assertNothingForbidden, publishSet, repoRoot } from "./publish-set.mjs";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "consumer-fixture");
const keep = process.argv.includes("--keep");

/** Run a command, streaming failure output rather than swallowing it. */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function step(label) {
  console.log(`\n→ ${label}`);
}

function fail(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail !== undefined) console.error(detail);
  process.exit(1);
}

// --- 1. Pack --------------------------------------------------------------------------------

const packages = publishSet();
assertNothingForbidden(packages);

step(`Packing ${packages.length} packages`);
const tarballDir = mkdtempSync(join(tmpdir(), "aldus-tarballs-"));
const packed = packAll(tarballDir);
for (const pkg of packed) console.log(`   ${pkg.name}@${pkg.version}`);

// A published tarball that carries neither licence nor notice violates Apache-2.0 §4(a). The
// per-package test covers the manifest; this covers the artifact that actually ships.
for (const pkg of packed) {
  for (const required of ["package/LICENSE", "package/NOTICE"]) {
    if (!pkg.files.includes(required.replace("package/", ""))) {
      fail(`${pkg.name} packed without ${required.replace("package/", "")}`);
    }
  }
}

// --- 2. Clean consumer, outside the monorepo -------------------------------------------------

step("Creating a clean consumer project outside the monorepo");
const consumerRoot = mkdtempSync(join(tmpdir(), "aldus-consumer-"));
if (realpathSync(consumerRoot).startsWith(realpathSync(repoRoot))) {
  fail("the consumer directory is inside the monorepo, which would invalidate the whole gate");
}
console.log(`   ${consumerRoot}`);

// Every @aldus-runtime dependency is pinned to a `file:` **tarball**, not a directory. That
// distinction is the gate: npm symlinks a `file:` directory and extracts a `file:` tarball, and
// only the second proves the published artifact stands on its own.
//
// `overrides` covers the transitive case. Internal dependencies are exact pins to a version that
// is not on the registry (ADR-0020), so without an override npm would try to fetch
// `@aldus-runtime/core@0.1.0` from npmjs and fail — or, worse, one day succeed against something
// unrelated. Overriding every internal name to its local tarball keeps resolution entirely local
// while leaving genuine third-party dependencies (zod) to resolve normally from the registry,
// which is itself worth proving.
const byName = Object.fromEntries(packed.map((pkg) => [pkg.name, `file:${pkg.tarball}`]));

writeFileSync(
  join(consumerRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "aldus-clean-consumer",
      version: "0.0.0",
      private: true,
      type: "module",
      description: "Throwaway project proving the published tarballs install and work.",
      dependencies: byName,
      // @types/node is a realistic consumer dependency, and required here: the published
      // declarations reference Node globals (`AbortSignal` on stage cancellation, `Headers` on
      // `redactHeaders`). A consumer without it gets errors from inside our own .d.ts files.
      // Whether the packages should declare @types/node themselves is a real question — see
      // the note in docs/RELEASING.md.
      devDependencies: {
        typescript: readTypeScriptRange(),
        "@types/node": readTypesNodeRange(),
      },
      overrides: byName,
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(consumerRoot, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2023",
        lib: ["ES2023"],
        module: "NodeNext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        types: ["node"],
        skipLibCheck: false,
      },
      files: ["types.ts"],
    },
    null,
    2,
  )}\n`,
);

mkdirSync(join(consumerRoot, "src"), { recursive: true });
cpSync(join(fixtureDir, "smoke.mjs"), join(consumerRoot, "smoke.mjs"));
cpSync(join(fixtureDir, "types.ts"), join(consumerRoot, "types.ts"));

/** Use the same TypeScript the monorepo builds with, so a declaration gap is not a version gap. */
function readTypeScriptRange() {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  return root.devDependencies?.typescript ?? "latest";
}

/** Match the @types/node the packages were built against, for the same reason. */
function readTypesNodeRange() {
  for (const pkg of publishSet()) {
    const range = pkg.manifest.devDependencies?.["@types/node"];
    if (range !== undefined) return range;
  }
  return "latest";
}

// --- 3. Install only the tarballs ------------------------------------------------------------

step("Installing the tarballs (no workspace, no link)");
try {
  // --install-links would copy directory dependencies; there are none, and passing it makes the
  // intent explicit: nothing here may become a link.
  run("npm", ["install", "--no-audit", "--no-fund", "--install-links"], { cwd: consumerRoot });
} catch (error) {
  fail("npm install failed in the clean consumer", error.stdout ?? error.stderr ?? String(error));
}

// --- 4. Nothing resolves back into the monorepo ----------------------------------------------

step("Checking nothing resolves into the monorepo");
for (const pkg of packed) {
  const installed = join(consumerRoot, "node_modules", ...pkg.name.split("/"));
  let real;
  try {
    real = realpathSync(installed);
  } catch {
    fail(`${pkg.name} was not installed at all`);
  }
  if (real.startsWith(realpathSync(repoRoot))) {
    fail(`${pkg.name} resolved to ${real}, inside the monorepo — the gate proved nothing`);
  }
  const version = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;
  if (version !== pkg.version) {
    fail(`${pkg.name} installed at ${version}, expected ${pkg.version}`);
  }
}
console.log(`   ${packed.length} packages, all extracted copies at the packed version`);

// --- 5. Declarations resolve ------------------------------------------------------------------

step("Typechecking a consumer against the published declarations");
try {
  run("npx", ["tsc", "--project", "tsconfig.json"], { cwd: consumerRoot });
  console.log("   declarations resolve under moduleResolution: nodenext");
} catch (error) {
  fail(
    "a consumer cannot typecheck against the published declarations",
    error.stdout ?? error.stderr,
  );
}

// --- 6. Runtime smoke flow ---------------------------------------------------------------------

step("Running the smoke flow");
try {
  const output = run("node", ["smoke.mjs"], {
    cwd: consumerRoot,
    env: { ...process.env, ALDUS_MONOREPO_ROOT: repoRoot },
  });
  console.log(
    output
      .trim()
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n"),
  );
} catch (error) {
  fail("the smoke flow failed", `${error.stdout ?? ""}${error.stderr ?? ""}`);
}

// --- 7. Each package's own dependency closure ---------------------------------------------------

// The combined consumer above installs all twelve packages by name, so it can never prove that
// any one of them *declared* what it imports — everything is present regardless. That is the
// trap: a gate that installs the whole set tests a fiction.
//
// So each package is also installed alone, with `overrides` still pointing every internal name
// at a local tarball but `dependencies` naming only the package under test. npm then installs
// exactly that package's declared closure, and importing it executes its module graph. A package
// that imports something it declared only as a devDependency fails here, which is precisely the
// defect @aldus-runtime/cli and @aldus-runtime/mcp shipped.

step("Installing each package alone, to exercise its declared dependencies");
const isolationRoot = mkdtempSync(join(tmpdir(), "aldus-isolation-"));
const isolationFailures = [];

for (const pkg of packed) {
  const dir = join(isolationRoot, pkg.name.replace("/", "__"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: `isolation-${pkg.name.replace("/", "-")}`,
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: { [pkg.name]: byName[pkg.name] },
        overrides: byName,
      },
      null,
      2,
    )}\n`,
  );

  try {
    // --install-strategy=nested defeats hoisting, and that is the entire point of this phase.
    // Under npm's default hoisting a package can import something it never declared and still
    // resolve it, because a *sibling* dependency pulled it to the top level. That is how
    // @aldus-runtime/cli's missing file-store declaration stayed invisible: services declared it,
    // so it sat at the root of node_modules and the CLI found it by luck. Nested placement puts
    // each package's dependencies beneath it, so only what a package actually declared is
    // reachable from it.
    run("npm", ["install", "--no-audit", "--no-fund", "--install-strategy=nested"], { cwd: dir });
  } catch (error) {
    isolationFailures.push(
      `${pkg.name}: install failed — ${error.stdout ?? error.stderr ?? error}`,
    );
    continue;
  }

  try {
    // Importing executes the module graph, so a missing runtime dependency throws here rather
    // than lying dormant until an adopter hits the code path.
    run("node", ["--input-type=module", "-e", `await import(${JSON.stringify(pkg.name)});`], {
      cwd: dir,
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`
      .trim()
      .split("\n")
      .slice(0, 3)
      .join(" | ");
    isolationFailures.push(`${pkg.name}: import failed — ${detail}`);
  }
}

rmSync(isolationRoot, { recursive: true, force: true });

if (isolationFailures.length > 0) {
  fail(
    `${isolationFailures.length} package(s) do not declare everything they import`,
    isolationFailures.map((line) => `  - ${line}`).join("\n"),
  );
}
console.log(`   ${packed.length} packages import cleanly from their own declared closure`);

// --- 8. The binary runs -------------------------------------------------------------------------

step("Invoking the aldus binary");
const binary = join(consumerRoot, "node_modules", ".bin", "aldus");
try {
  const help = run(binary, ["--help"], { cwd: consumerRoot });
  if (!help.includes("aldus")) fail("aldus --help produced no usage text");
  console.log("   aldus --help");
} catch (error) {
  fail("the aldus binary did not run", `${error.stdout ?? ""}${error.stderr ?? ""}`);
}

try {
  // A read-only command against an uninitialised workspace: it must answer, not crash.
  run(binary, ["status", "--json"], { cwd: consumerRoot });
  console.log("   aldus status --json");
} catch (error) {
  // A non-zero exit is legitimate here — an uninitialised workspace is a refusal, not a crash.
  const combined = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  if (!combined.includes("{")) {
    fail("aldus status --json emitted no JSON", combined);
  }
  console.log("   aldus status --json (refused, with JSON — correct for an empty workspace)");
}

// --- Done ---------------------------------------------------------------------------------------

if (!keep) {
  rmSync(consumerRoot, { recursive: true, force: true });
  rmSync(tarballDir, { recursive: true, force: true });
} else {
  console.log(`\nKept: ${consumerRoot}\nKept: ${tarballDir}`);
}

console.log(`\n✓ clean-consumer gate passed for ${packed.length} packages`);
