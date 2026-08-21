/**
 * The mutant cases for this repository's checks, as data.
 *
 * A review request names `node scripts/run-mutants.mjs` and the cases live here, so they are
 * reviewable in the diff rather than pasted into a comment and re-run through a reader's shell.
 * Two shells produced two invalid measurements in one day; taking both out of the path is cheaper
 * than either of us being careful.
 *
 * Every case states an **expected output fragment**, not only an exit code. A missing file, a
 * misspelled filename and a real negative all exit non-zero — `MODULE_NOT_FOUND` read as a
 * meaningful status is exactly how both invalid runs happened — so a status alone cannot tell a
 * finding from a typo.
 */

/** `append` writes a line to a file; `version` sets aldus-core's version. Both are committed. */
export const cases = [
  {
    name: "version-bump: a src/ change to a published package must fire",
    setup: [{ append: ["packages/aldus-core/src/schema-version.ts", "// mutant"] }],
    command: ["node", "scripts/check-version-bump.mjs", "origin/main"],
    wantExit: 1,
    wantOutput: "does not bump the version",
  },
  {
    name: "version-bump: a test/ change must NOT fire (the over-firing that made merge-time unworkable)",
    setup: [{ append: ["packages/aldus-core/test/schema-version.test.ts", "// mutant"] }],
    command: ["node", "scripts/check-version-bump.mjs", "origin/main"],
    wantExit: 0,
    wantOutput: "none alter shipped contents",
  },
  {
    name: "version-bump: a schema/ change must fire (aldus-core ships schema, others do not)",
    setup: [{ append: ["packages/aldus-core/schema/actor-ref.schema.json", ""] }],
    command: ["node", "scripts/check-version-bump.mjs", "origin/main"],
    wantExit: 1,
    wantOutput: "packages/aldus-core — still",
  },
  {
    name: "version-bump: a docs-only change must NOT fire",
    setup: [{ append: ["docs/adr/README.md", ""] }],
    command: ["node", "scripts/check-version-bump.mjs", "origin/main"],
    wantExit: 0,
    wantOutput: "none alter shipped contents",
  },
  {
    name: "version-bump: a src/ change WITH a bump must NOT fire",
    setup: [
      { append: ["packages/aldus-core/src/schema-version.ts", "// mutant"] },
      { version: "0.2.0-next.21" },
    ],
    command: ["node", "scripts/check-version-bump.mjs", "origin/main"],
    wantExit: 0,
    wantOutput: "none alter shipped contents",
  },
  {
    // The failure that turned `main` red on the first run after the trigger moved. CI's checkout is
    // shallow, so the previous commit was absent and "cannot read the history" was inferred as
    // "bumped to a version already published". A SHA no repository contains reproduces it.
    name: "release-intent: an unreadable previous version publishes nothing, not a republish claim",
    setup: [],
    command: ["node", "scripts/release-intent.mjs", "0".repeat(40)],
    wantExit: 0,
    wantOutput: "publishing nothing rather than inferring intent",
  },
  {
    name: "release-intent: an unchanged version publishes nothing",
    setup: [],
    command: ["node", "scripts/release-intent.mjs", "HEAD"],
    wantExit: 0,
    wantOutput: "version unchanged",
  },
  {
    name: "claim-scope: an unknown claim must refuse rather than be satisfied",
    setup: [],
    command: ["node", "scripts/check-claim-scope.mjs", "origin/main", "not-a-real-claim"],
    wantExit: 2,
    wantOutput: "unknown claim",
  },
  {
    name: "claim-scope: docs-only is false for a PR carrying scripts and workflows",
    setup: [],
    command: ["node", "scripts/check-claim-scope.mjs", "origin/main", "docs-only"],
    wantExit: 1,
    wantOutput: 'The claim "docs-only" is false',
  },
  {
    name: "claim-scope: no-shipped-change holds for this PR",
    setup: [],
    command: ["node", "scripts/check-claim-scope.mjs", "origin/main", "no-shipped-change"],
    wantExit: 0,
    wantOutput: "holds across",
  },
  {
    name: "resolution-surface: the reviewed resolution smuggled nothing",
    setup: [],
    command: ["node", "scripts/check-resolution-surface.mjs", "97f1ae5"],
    wantExit: 0,
    wantOutput: "within the union",
  },
  {
    name: "resolution-surface: a non-merge must refuse rather than pass",
    setup: [],
    command: ["node", "scripts/check-resolution-surface.mjs", "44e31ac"],
    wantExit: 2,
    wantOutput: "is not a merge commit",
  },
  {
    // The emitter must never let a non-answer read as an answer — the failure mode that cost the
    // most across this series. `--base HEAD` is an empty diff, which is exactly #176's condition:
    // the claim checks refuse as vacuous, and the block must exit non-zero rather than print a
    // clean-looking table.
    //
    // The first version of this case used a forty-zero base, on the assumption that an unknown ref
    // would make them decline. It does not — that was a premise asserted rather than checked, in a
    // case written to catch exactly that.
    name: "evidence: a declined check exits non-zero rather than printing a clean block",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--no-mutants", "--base", "HEAD"],
    wantExit: 2,
    wantOutput: "DECLINED to answer",
  },
  {
    name: "evidence: a false claim reads as FALSE, not as a failing check",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--no-mutants"],
    wantExit: 0,
    wantOutput: "claim: docs-only",
  },
  {
    name: "generic-boundary: an adopter name in docs/ must fire (the breach that got through)",
    setup: [{ append: ["docs/adr/README.md", "megaphone" + "-aldus"] }],
    command: ["node", "scripts/check-generic-boundary.mjs"],
    wantExit: 1,
    wantOutput: "[adopter]",
  },
  {
    name: "generic-boundary: a provider name in docs/ must NOT fire (§4.2 quotes them to state its rule)",
    setup: [{ append: ["docs/adr/README.md", "you" + "tube is an example"] }],
    command: ["node", "scripts/check-generic-boundary.mjs"],
    wantExit: 0,
    wantOutput: "no occurrences",
  },
];
