/**
 * The gate scripts distinguish a declined invocation from a gate result.
 *
 * Both scripts exit 2 when invoked with no base ref, which is a correct declined signal, and both
 * used to print one bare `usage:` line to say it. A reader who has the message but not the status
 * — an agent relaying output, a log with stderr and stdout interleaved — cannot tell that from a
 * gate that ran and failed. `DECLINED` is a third state and this file is the mechanism that keeps
 * it stated as one, so the wording cannot quietly regress to a usage line again.
 *
 * The other half is what this file protects while it does that: the declined path must not have
 * moved the real results. Each gate is exercised over a purpose-built fixture repository for a
 * genuine pass (exit 0) and a genuine failure (exit 1), asserting the existing messages.
 *
 * Found by the independent review of PR #263; same defect class as issue #228.
 *
 * The independent review of PR #264 left two things open, and both are closed here.
 * `check-claim-scope.mjs` had the identical defect and is now routed through the same
 * `declined.mjs`; and the review's fifth mutant SURVIVED — moving a declined guard below the
 * `publish-dirs.mjs` call changed nothing any test could see, because every case ran in the
 * repository root, where that call succeeds. "The guard is the first statement after argv is
 * read" was true by reading and untested, which is this repository's own false-green class.
 *
 * The last describe block is the mechanism for it, and it states the property as a behaviour
 * rather than a source position: **a declined invocation is decided before the gate touches the
 * repository**, so the answer to a missing or unusable argument cannot depend on where the script
 * was run. Running each gate from a directory that is not a git repository and has no `packages/`
 * distinguishes the two — with the guard first the gate still declines; with the guard below the
 * work, the work runs first and dies on the missing repository.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scriptsDir = join(repoRoot, "scripts");

const temporaries: string[] = [];
afterAll(() => {
  for (const path of temporaries) rmSync(path, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaries.push(path);
  return path;
}

/** Run one gate script and return its real exit status and streams. */
function runGate(script: string, args: string[], cwd: string, extraPath?: string) {
  const result = spawnSync("node", [join(cwd, "scripts", script), ...args], {
    cwd,
    encoding: "utf8",
    env:
      extraPath === undefined
        ? process.env
        : { ...process.env, PATH: `${extraPath}:${process.env.PATH ?? ""}` },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A fixture repository with an identity of its own, so the ambient git config cannot fail it. */
function initRepo(prefix: string): string {
  const root = scratch(prefix);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, "scripts"), { recursive: true });
  return root;
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function copyScripts(root: string, names: string[]): void {
  for (const name of names) cpSync(join(scriptsDir, name), join(root, "scripts", name));
}

function write(root: string, path: string, contents: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe("a gate invoked with no base ref says it declined (#263 review)", () => {
  for (const script of ["check-version-bump.mjs", "check-breaking-notes.mjs"]) {
    it(`${script} exits 2, names the missing argument, and shows a working invocation`, () => {
      const { status, stderr } = runGate(script, [], repoRoot);

      // Exit 2 is load-bearing: CI and ADR-0050 read these codes. The finding was never about
      // the status, it was about a message a reader could mistake for a gate result.
      expect(status).toBe(2);
      expect(stderr).toContain("DECLINED");
      expect(stderr).toContain(script);
      expect(stderr).toContain("<base-ref>");
      // Says what it is, in the two directions a reader could get it wrong.
      expect(stderr).toMatch(/NOT a gate pass/);
      expect(stderr).toMatch(/NOT a gate failure/);
      // And shows one invocation that would actually work, not a bare synopsis.
      expect(stderr).toContain(`node scripts/${script} origin/main`);
      // Nothing on stdout: a declined run has no result to report.
      expect(runGate(script, [], repoRoot).stdout).toBe("");
    });
  }
});

describe("check-claim-scope declines its two arguments distinctly (#264 review)", () => {
  const usage = "node scripts/check-claim-scope.mjs origin/main docs-only";

  it("exits 2 naming <base-ref> when invoked with no arguments", () => {
    const { status, stdout, stderr } = runGate("check-claim-scope.mjs", [], repoRoot);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("DECLINED: check-claim-scope.mjs was invoked with no <base-ref>");
    expect(stderr).toMatch(/NOT a gate pass/);
    expect(stderr).toMatch(/NOT a gate failure/);
    expect(stderr).toContain(usage);
  });

  it("exits 2 naming <claim> when the second argument is missing", () => {
    const { status, stdout, stderr } = runGate("check-claim-scope.mjs", ["origin/main"], repoRoot);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("DECLINED: check-claim-scope.mjs was invoked with no <claim>");
    // The synopsis names BOTH arguments, not only the one that was missing: a reader who left the
    // claim off still has to be shown what the gate takes.
    expect(stderr).toContain("<base-ref> <docs-only|no-shipped-change>");
    expect(stderr).toContain(usage);
  });

  it("exits 2 naming the claim it does not know, distinctly from a missing one", () => {
    const { status, stdout, stderr } = runGate(
      "check-claim-scope.mjs",
      ["origin/main", "test-only"],
      repoRoot,
    );
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain('DECLINED: check-claim-scope.mjs does not know the claim "test-only"');
    // Distinct from the missing-argument message, which is the whole point of the case.
    expect(stderr).not.toContain("was invoked with no");
    expect(stderr).toContain("declined rather than failed");
    expect(stderr).toContain(usage);
  });
});

describe("check-claim-scope still returns real results", () => {
  const root = initRepo("aldus-gate-claim-");
  copyScripts(root, [
    "check-claim-scope.mjs",
    "publish-dirs.mjs",
    "publish-set.mjs",
    "declined.mjs",
  ]);
  write(
    root,
    "packages/example-a/package.json",
    `${JSON.stringify({ name: "@example/a", version: "1.0.0", files: ["src"] }, null, 2)}\n`,
  );
  write(root, "packages/example-a/src/index.js", "export const alpha = 1;\n");
  write(root, "packages/example-a/test/alpha.test.js", "// base\n");
  write(root, "docs/note.md", "base\n");
  const base = commitAll(root, "base");

  it('exits 0 when "docs-only" holds', () => {
    write(root, "docs/note.md", "a documentation change\n");
    commitAll(root, "docs change");

    const { status, stdout } = runGate("check-claim-scope.mjs", [base, "docs-only"], root);
    expect(status).toBe(0);
    expect(stdout).toContain('"docs-only" holds across 1 changed paths');
  });

  it('exits 1 when "docs-only" is false, naming the path that contradicts it', () => {
    write(root, "packages/example-a/src/index.js", "export const alpha = 2;\n");
    commitAll(root, "a shipped change");

    const { status, stderr } = runGate("check-claim-scope.mjs", [base, "docs-only"], root);
    expect(status).toBe(1);
    expect(stderr).toContain('The claim "docs-only" is false');
    expect(stderr).toContain("packages/example-a/src/index.js");
  });

  it('exits 1 when "no-shipped-change" is false, checked against the files-scope', () => {
    const { status, stderr } = runGate("check-claim-scope.mjs", [base, "no-shipped-change"], root);
    expect(status).toBe(1);
    expect(stderr).toContain('The claim "no-shipped-change" is false');
    expect(stderr).toContain("packages/example-a/src/index.js");
    // `docs/` and the package's tests are outside the `files` scope, so they never ship.
    expect(stderr).not.toContain("docs/note.md");
    expect(stderr).not.toContain("test/alpha.test.js");
  });
});

describe("check-version-bump still returns real results", () => {
  // `publish-set.mjs` derives the repository root from its own location, so the fixture carries
  // its own copy of the script chain. The gate under test is the real file, unmodified.
  const root = initRepo("aldus-gate-bump-");
  copyScripts(root, [
    "check-version-bump.mjs",
    "publish-dirs.mjs",
    "publish-set.mjs",
    "declined.mjs",
  ]);
  write(
    root,
    "packages/example-a/package.json",
    `${JSON.stringify({ name: "@example/a", version: "1.0.0", files: ["src"] }, null, 2)}\n`,
  );
  write(root, "packages/example-a/src/index.js", "export const alpha = 1;\n");
  write(root, "packages/example-a/test/alpha.test.js", "// base\n");
  const base = commitAll(root, "base");

  it("exits 0 when the change ships nothing", () => {
    write(root, "packages/example-a/test/alpha.test.js", "// a test-only change ships nothing\n");
    commitAll(root, "test-only");

    const { status, stdout } = runGate("check-version-bump.mjs", [base], root);
    expect(status).toBe(0);
    expect(stdout).toContain("none alter shipped contents without a bump");
  });

  it("exits 1 when shipped contents change with no bump", () => {
    write(root, "packages/example-a/src/index.js", "export const alpha = 2;\n");
    commitAll(root, "shipped change, no bump");

    const { status, stderr } = runGate("check-version-bump.mjs", [base], root);
    expect(status).toBe(1);
    expect(stderr).toContain("does not bump the version (ADR-0050)");
    expect(stderr).toContain("packages/example-a — still 1.0.0");
  });
});

describe("check-breaking-notes still returns real results", () => {
  // The fixture commits its `.d.ts` files, so the base surface comes from the checkout rather
  // than from a build. `npm` and `npx` are stubbed to fail fast on PATH: the script only uses
  // their exit codes for a diagnostic, and letting `npx tsc` reach the network from a test would
  // measure the registry rather than the gate. Stated because it is what this suite does NOT
  // establish — that the real worktree build path works is checked by CI running the gate itself.
  const root = initRepo("aldus-gate-breaking-");
  copyScripts(root, ["check-breaking-notes.mjs", "breaking-coverage.mjs", "declined.mjs"]);
  write(
    root,
    "package.json",
    `${JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2)}\n`,
  );
  write(root, "CHANGELOG.md", "# Changelog\n\n## Unreleased\n\nNothing yet.\n");
  write(
    root,
    "packages/example-a/dist/index.d.ts",
    "export declare function alpha(): void;\nexport declare function beta(): void;\n",
  );
  write(root, "README.md", "base\n");
  const base = commitAll(root, "base");

  const stubBin = scratch("aldus-gate-stub-bin-");
  for (const name of ["npm", "npx"]) {
    const path = join(stubBin, name);
    writeFileSync(path, "#!/bin/sh\nexit 1\n");
    chmodSync(path, 0o755);
  }

  it("exits 0 when the export surface is unchanged", () => {
    write(root, "README.md", "an unshipped edit\n");
    commitAll(root, "no surface change");

    const { status, stdout } = runGate("check-breaking-notes.mjs", [base], root, stubBin);
    expect(status).toBe(0);
    expect(stdout).toContain(`No breaking surface change against ${base}`);
  });

  it("exits 1 when an export disappears with no BREAKING entry", () => {
    write(root, "packages/example-a/dist/index.d.ts", "export declare function alpha(): void;\n");
    commitAll(root, "remove beta");

    const { status, stderr } = runGate("check-breaking-notes.mjs", [base], root, stubBin);
    expect(status).toBe(1);
    expect(stderr).toContain("breaking surface change(s) against");
    expect(stderr).toContain("carries no BREAKING entry");
    expect(stderr).toContain("example-a:beta");
  });
});

describe("a declined invocation is decided before the gate touches the repository (#264 review)", () => {
  // PR #264's review ran five mutants and killed four. The survivor moved the declined guard in
  // `check-version-bump.mjs` below the `publish-dirs.mjs` call — a change that makes the gate do
  // real work before deciding it has no arguments, and that every test above still passed,
  // because they all run in the repository root where that call succeeds.
  //
  // So the discriminating environment is a directory the gate needs and does not have: the
  // scripts, and nothing else. Not a git repository, no `packages/`, no manifests. With the guard
  // first, each gate still declines and says so. With the guard below the work, the work runs
  // first and dies on the missing repository — a different exit and no declined message.
  //
  // What this does NOT establish: that the guard is literally the first statement. It pins the
  // property that matters — a declined answer is independent of the environment — and a
  // rearrangement that keeps that property is one this file has no opinion about.
  const bare = scratch("aldus-gate-bare-");
  mkdirSync(join(bare, "scripts"), { recursive: true });
  copyScripts(bare, [
    "check-version-bump.mjs",
    "check-breaking-notes.mjs",
    "check-claim-scope.mjs",
    "breaking-coverage.mjs",
    "publish-dirs.mjs",
    "publish-set.mjs",
    "declined.mjs",
  ]);

  const cases: ReadonlyArray<{ script: string; args: string[]; says: string }> = [
    { script: "check-version-bump.mjs", args: [], says: "was invoked with no <base-ref>" },
    { script: "check-breaking-notes.mjs", args: [], says: "was invoked with no <base-ref>" },
    { script: "check-claim-scope.mjs", args: [], says: "was invoked with no <base-ref>" },
    { script: "check-claim-scope.mjs", args: ["origin/main"], says: "was invoked with no <claim>" },
    {
      script: "check-claim-scope.mjs",
      args: ["origin/main", "not-a-claim"],
      says: 'does not know the claim "not-a-claim"',
    },
  ];

  for (const { script, args, says } of cases) {
    it(`${script} ${args.length > 0 ? `[${args.join(" ")}] ` : ""}declines with no repository at all`, () => {
      const { status, stdout, stderr } = runGate(script, args, bare);

      // Exit 2 and the declined wording, from a directory where every later step would throw.
      expect(status).toBe(2);
      expect(stdout).toBe("");
      expect(stderr).toContain("DECLINED");
      expect(stderr).toContain(says);
      // The fragment matters as much as the status here: `check-breaking-notes.mjs` has a second,
      // unrelated DECLINED for a missing build, and a guard moved below the work would reach it.
      // Asserting only on "DECLINED" would read that non-answer as this one.
      expect(stderr).toMatch(/NOT a gate pass/);
      expect(stderr).toContain(`node scripts/${script} `);
    });
  }
});
