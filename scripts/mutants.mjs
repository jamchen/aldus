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
    // The guard itself: a setup that edits a built source, measured **through the package
    // boundary** rather than by a script reading files. Without a rebuild between the edit and the
    // measurement, `@aldus-runtime/core` resolves through `exports` to `dist` and the importer sees
    // the previous value — so the case would pass while measuring nothing.
    name: "runner: a mutation to a built source reaches an importer (rebuild before measuring)",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema-version.ts",
          // A pattern, not a literal: pinning the current version made this case go stale on the
          // next bump, and it refused for three of them.
          /export const SCHEMA_VERSION = "[\d.]+"/,
          'export const SCHEMA_VERSION = "99.99"',
        ],
      },
    ],
    command: [
      "node",
      "--input-type=module",
      "-e",
      "const m = await import('@aldus-runtime/core'); if (m.SCHEMA_VERSION !== '99.99') { console.error('stale build: SCHEMA_VERSION is ' + m.SCHEMA_VERSION); process.exit(1); } console.log('importer saw the mutation');",
    ],
    wantExit: 0,
    wantOutput: "importer saw the mutation",
  },
  {
    // The adopter's failure and mine, one argument apart: they probed a check with `--check` where
    // the flag is `--verify`, their harness ignored it, ran the whole suite, and reported SURVIVED
    // for a mutation the named check catches on sight. A typo'd `--suite` here would have skipped
    // suite measurement and still printed a block that looks complete.
    name: "evidence: an unknown flag refuses rather than being ignored",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--suite", "--no-mutants"],
    wantExit: 2,
    wantOutput: 'unknown flag "--suite"',
  },
  {
    // The negative control. Without it the case above passes for an emitter that refuses every
    // invocation, which would be exactly as broken and much easier to miss.
    name: "evidence: a known flag still runs",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--no-mutants"],
    wantExit: 0,
    wantOutput: "head:",
  },
  {
    // The blind spot, named. A Zod-inferred export cannot be classified — optionality lives in
    // `z.ZodOptional<…>` rather than in a `?` — and for one release that meant the check reported
    // one break out of two and said nothing about the half it could not see. Validated against
    // that release: it now names `ReworkPolicy`.
    name: "breaking-notes: a changed Zod-inferred export is named as unclassifiable",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/rework.ts",
          "maxRounds: z.int().min(1),",
          "maxRounds: z.int().min(1),\n    mutantField: nonEmptyString.optional(),",
        ],
      },
    ],
    command: ["node", "scripts/check-breaking-notes.mjs", "{{BASE}}"],
    wantExit: 0,
    wantOutput: "aldus-core:ReworkPolicy",
  },
  {
    name: "breaking-notes: the interface kind-change regression kills a disabled detector",
    setup: [
      {
        replace: [
          "scripts/breaking-coverage.mjs",
          // A pattern, not a literal. The literal pinned here was the scalar comparison
          // `baseDeclarations.get(key) === "interface"`, and the fix that made kinds a set
          // rewrote that expression — so the case refused before running anything, on the very
          // commit it was meant to guard. A case is a claim too, and this one expired in one
          // commit.
          /baseDeclarations\.get\(key\)\??\.?has\("interface"\) === true|baseDeclarations\.get\(key\) === "interface"/,
          'false /* mutant */ && baseDeclarations.get(key)?.has("interface") === true',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "packages/aldus-e2e/test/breaking-coverage.test.ts",
      "-t",
      "reports the ReworkVerdict interface-to-discriminated-union change",
    ],
    wantExit: 1,
    wantOutput: "reports the ReworkVerdict interface-to-discriminated-union change",
  },
  {
    // The scalar this replaced was declaration-order dependent, and its two failure modes point
    // opposite ways: an unchanged interface followed by a same-named value read as a kind change
    // that never happened, and an interface replaced by an alias while the value survived read as
    // no change at all. Both are legal TypeScript, so the case has to reach the aggregation itself.
    name: "breaking-notes: removing the kind aggregation is caught by the merged-declaration cases",
    setup: [
      {
        replace: [
          "scripts/breaking-coverage.mjs",
          /const kinds = declarations\.get\(key\)[\s\S]*?declarations\.set\(key, kinds\);/,
          "declarations.set(key, new Set([match[1]]));",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "packages/aldus-e2e/test/breaking-coverage.test.ts",
      "-t",
      "a legal type/value namespace merge",
    ],
    wantExit: 1,
    wantOutput: "records every kind it saw, in either order",
  },
  {
    // The same defect one level up, in the caller. A package emits many `.d.ts` files, so the two
    // halves of a legal merge can arrive from different ones; folding them with `Map.set` loses
    // whichever half is read first and re-creates the scalar's silence from outside the extractor.
    name: "breaking-notes: folding per-file surfaces with set() instead of union is caught",
    setup: [
      {
        replace: [
          "scripts/breaking-coverage.mjs",
          /const into = whole\.declarations\.get\(key\)[\s\S]*?whole\.declarations\.set\(key, into\);/,
          "whole.declarations.set(key, kinds);",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "packages/aldus-e2e/test/breaking-coverage.test.ts",
      "-t",
      "merging the per-file surfaces of one package",
    ],
    wantExit: 1,
    wantOutput: "reports a cross-file interface-to-alias change",
  },
  {
    name: "version-bump: a src/ change to a published package must fire",
    setup: [{ append: ["packages/aldus-core/src/schema-version.ts", "// mutant"] }],
    command: ["node", "scripts/check-version-bump.mjs", "{{BASE}}"],
    wantExit: 1,
    wantOutput: "does not bump the version",
  },
  {
    name: "version-bump: a test/ change must NOT fire (the over-firing that made merge-time unworkable)",
    setup: [{ append: ["packages/aldus-core/test/schema-version.test.ts", "// mutant"] }],
    command: ["node", "scripts/check-version-bump.mjs", "{{BASE}}"],
    wantExit: 0,
    wantOutput: "none alter shipped contents",
  },
  {
    name: "version-bump: a schema/ change must fire (aldus-core ships schema, others do not)",
    setup: [{ append: ["packages/aldus-core/schema/actor-ref.schema.json", ""] }],
    command: ["node", "scripts/check-version-bump.mjs", "{{BASE}}"],
    wantExit: 1,
    wantOutput: "packages/aldus-core — still",
  },
  {
    name: "version-bump: a docs-only change must NOT fire",
    setup: [{ append: ["docs/adr/README.md", ""] }],
    command: ["node", "scripts/check-version-bump.mjs", "{{BASE}}"],
    wantExit: 0,
    wantOutput: "none alter shipped contents",
  },
  {
    name: "version-bump: a src/ change WITH a bump must NOT fire",
    setup: [
      { append: ["packages/aldus-core/src/schema-version.ts", "// mutant"] },
      { version: "0.2.0-next.21" },
    ],
    command: ["node", "scripts/check-version-bump.mjs", "{{BASE}}"],
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
    // These three carried `setup: []` and measured **the branch you happened to be on**, against
    // `origin/main`. That made their result a fact about the current PR rather than about the
    // checker: "no-shipped-change holds for this PR" is false on any branch touching `src`, and it
    // failed for that reason rather than for a defect. A case whose answer depends on where it is
    // run is a case that will be red for the wrong reason and then ignored.
    name: "claim-scope: an unknown claim must refuse rather than be satisfied",
    setup: [{ append: ["docs/adr/README.md", ""] }],
    command: ["node", "scripts/check-claim-scope.mjs", "{{BASE}}", "not-a-real-claim"],
    wantExit: 2,
    wantOutput: "unknown claim",
  },
  {
    name: "claim-scope: docs-only is false for a PR carrying a script",
    setup: [{ append: ["scripts/mutants.mjs", "// mutant"] }],
    command: ["node", "scripts/check-claim-scope.mjs", "{{BASE}}", "docs-only"],
    wantExit: 1,
    wantOutput: 'The claim "docs-only" is false',
  },
  {
    name: "claim-scope: no-shipped-change holds for a docs-only diff",
    setup: [{ append: ["docs/adr/README.md", ""] }],
    command: ["node", "scripts/check-claim-scope.mjs", "{{BASE}}", "no-shipped-change"],
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
    name: "evidence --check: a complete block passes and surfaces its report-backed claims",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--check", "scripts/fixtures/evidence/complete.md"],
    wantExit: 0,
    wantOutput: "rest on a report rather than on code",
  },
  {
    name: "evidence --check: a residual placeholder is refused",
    setup: [],
    command: [
      "node",
      "scripts/evidence.mjs",
      "--check",
      "scripts/fixtures/evidence/residual-fill.md",
    ],
    wantExit: 1,
    wantOutput: "placeholder(s) still present",
  },
  {
    name: "evidence --check: a claim with no locus is refused",
    setup: [],
    command: [
      "node",
      "scripts/evidence.mjs",
      "--check",
      "scripts/fixtures/evidence/missing-verified-at.md",
    ],
    wantExit: 1,
    wantOutput: "has no `verified at:`",
  },
  {
    name: "evidence --check: a claim with no invalidator is refused",
    setup: [],
    command: [
      "node",
      "scripts/evidence.mjs",
      "--check",
      "scripts/fixtures/evidence/missing-invalidated-by.md",
    ],
    wantExit: 1,
    wantOutput: "has no `invalidated by:`",
  },
  {
    name: "evidence --check: a block with no claims establishes nothing and is refused",
    setup: [],
    command: ["node", "scripts/evidence.mjs", "--check", "scripts/fixtures/evidence/no-claims.md"],
    wantExit: 1,
    wantOutput: "no `claims:` section",
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
    // The rebuild predicate's assumption, checked. Adding a second compile input to any package
    // means a mutation there would not trigger a rebuild and so would not reach the code under
    // test — the failure the rebuild guard exists to catch, arriving through the predicate rather
    // than through a missing rebuild.
    name: "build-topology: a package compiling outside src must be refused",
    setup: [
      {
        replace: [
          "packages/aldus-core/tsconfig.json",
          '"src/**/*.ts"',
          '"src/**/*.ts", "schema/**/*.ts"',
        ],
      },
    ],
    command: ["node", "scripts/check-build-topology.mjs"],
    wantExit: 1,
    wantOutput: "not only src/",
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
  {
    // Not a check on `scripts/` but on a value-safety rule, because the rule is the kind that
    // fails silently: a summary naming a `z.record` key leaks it into `events.jsonl` and a CLI
    // line, and nothing goes red. This puts the withdrawn behaviour back and asserts the case
    // that forbids it actually catches it (#255).
    name: "validate: naming the failing path in a summary must fail the case that forbids it",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/validate.ts",
          'failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,',
          'failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.map((issue) => issue.path).join(", ")}.`,',
        ],
      },
    ],
    command: ["npx", "vitest", "run", "--root", "packages/aldus-core", "test/validate.test.ts"],
    wantExit: 1,
    wantOutput: "does not put a caller-supplied record key into the message",
  },
  {
    // The same mutation, measured in another package: the runner quotes the refusal's message
    // verbatim into a durable degraded record, so Core naming a path there reaches the record
    // whatever the runner's own filter withholds. Measured across the package boundary, which is
    // what makes the rebuild guard load-bearing for this case.
    name: "validate: a path in Core's summary reaches the runner's degraded record",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/validate.ts",
          'failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,',
          'failed schema validation (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues.map((issue) => issue.path).join(", ")}.`,',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-stage-runner",
      "test/oversized-error.test.ts",
    ],
    wantExit: 1,
    wantOutput: "does not inherit a path from the summary it quotes",
  },
  {
    // The runner's own half of the same rule (#255). An interim fix persisted the rejected paths
    // it judged schema-owned by their shape; the port it appends through guarantees no such
    // provenance, so a conforming store can name a caller-supplied key. This puts the withdrawn
    // behaviour back and asserts the regression that forbids it actually catches it.
    name: "runner: persisting a rejected path in a degraded record must fail the case that forbids it",
    setup: [
      {
        replace: [
          "packages/aldus-stage-runner/src/runner.ts",
          "      ...(withheld > 0 ? { withheldPathCount: withheld } : {}),",
          "      ...(withheld > 0 ? { rejectedPaths: validationIssuePaths(refusal) } : {}),\n      ...(withheld > 0 ? { withheldPathCount: withheld } : {}),",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-stage-runner",
      "test/oversized-error.test.ts",
    ],
    wantExit: 1,
    wantOutput: "lets the caller's key reach neither the message nor the details",
  },
  /* ---------------------------------------------------------------------------------------------
   * #244 — reservation evidence at the takeover refusal.
   *
   * Every guard the design named as load-bearing, switched off individually. Each case asserts the
   * **distinguishing** clause of the test it kills, not a substring the other verdicts also
   * satisfy — #246's surviving mutation was exactly that mistake.
   * ------------------------------------------------------------------------------------------ */
  {
    // Aggregation across the stage is the join that does not lie. Without the stage scope, a
    // sibling stage's prepared reservation answers for this one — a message about the wrong money.
    name: "dispatch-evidence: dropping the stage scope lets another stage answer for this one",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/reservation.ts",
          "      reservation.stageId === scope.stageId &&",
          "      true /* mutant */ &&",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-core",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "does not let another stage's prepared reservation answer for this one",
  },
  {
    // Scoping by the stuck attempt instead. `reserve` resolves idempotency on `effectKey` and
    // returns the existing reservation unchanged, so the reservation keeps the *first* attempt's
    // id — an attempt-keyed read finds nothing while a dispatched reservation stands.
    name: "dispatch-evidence: scoping by attemptId instead of stage misses a dispatched reservation",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/reservation.ts",
          "      reservation.stageId === scope.stageId &&",
          '      reservation.attemptId === "att-10" /* mutant */ &&',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-services",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "sees a dispatched reservation that a retry left carrying the first attempt's id",
  },
  {
    // Trusting absence. A free stage, an empty store and a grant nobody could read are all zero
    // reservations from here; calling that the safe row claims a measurement nobody took.
    name: "dispatch-evidence: treating an empty result as safe claims safety for every free stage",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/reservation.ts",
          'if (relevant.length === 0) return "indeterminate";',
          'if (relevant.length === 0) return "reserved_never_dispatched"; /* mutant */',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-core",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "reads an empty stream as indeterminate, never as safe",
  },
  {
    // Ignoring `dispatch_prepared` — the one transition the whole distinction rests on, appended
    // before the provider call precisely so the window is visible rather than inferred.
    name: "dispatch-evidence: ignoring dispatch_prepared reports a prepared call as never dispatched",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/reservation.ts",
          'const reservedOnly = own.length === 1 && own[0]?.kind === "reservation.reserved";',
          'const reservedOnly = own.every((t) => t.kind !== "reservation.dispatch_identified"); /* mutant */',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-core",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "reads `dispatch_prepared` then nothing as possibly dispatched",
  },
  {
    // Reading the projection's `execution` field instead of the raw stream. `dispatch_identified`
    // is a legal successor of `reserved` with no `dispatch_prepared` between, and it leaves
    // `execution` undefined — so the projection calls a stream carrying a provider request id safe.
    name: "dispatch-evidence: reading reservation.execution instead of the stream misses an identified dispatch",
    setup: [
      {
        replace: [
          "packages/aldus-core/src/schema/reservation.ts",
          'const reservedOnly = own.length === 1 && own[0]?.kind === "reservation.reserved";',
          "const reservedOnly = own.length >= 0 && reservation.execution === undefined; /* mutant */",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-core",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput:
      "reads `dispatch_identified` with no `dispatch_prepared` between as possibly dispatched",
  },
  {
    // Inspecting one grant. `reserve` resolves idempotency per grant stream, so one `effectKey`
    // may hold a reservation in each of two grants and one grant's silence is not the stage's.
    name: "dispatch-evidence: reading only the first grant reports safety from half the store",
    setup: [
      {
        replace: [
          "packages/aldus-services/src/spend-service.ts",
          "const grantIds = [...new Set(reservations.map((reservation) => reservation.grantId))].sort();",
          "const grantIds = [...new Set(reservations.map((r) => r.grantId))].sort().slice(0, 1); /* mutant */",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-services",
      "test/stage-dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "reads every grant, not the first one holding a reservation for the Run",
  },
  {
    // Swallowing a per-grant read failure — the defect this change had to fix before the evidence
    // could be trusted. `[]` from a grant nobody could read is indistinguishable from a truthful
    // "nothing reserved", and the safe row would then be claimed from a failed read.
    name: "dispatch-evidence: swallowing a grant read error turns a held reservation into an empty stream",
    setup: [
      {
        replace: [
          "packages/aldus-file-store/src/reservation-store.ts",
          '      // An empty answer must come from an empty store, never from a failure to read one.\n      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];\n      throw error;',
          "      return []; /* mutant */",
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-file-store",
      "test/reservation-store.test.ts",
    ],
    wantExit: 1,
    wantOutput: "throws for a grant whose commits directory cannot be read",
  },
  {
    // An unwired runner assuming the safe row. The rule `gateHasDecision` states one field up: a
    // runner with no way to ask must not assume, and this is the field where assuming is a claim
    // about money.
    name: "dispatch-evidence: an unwired port assuming the safe row changes the message for every adopter",
    setup: [
      {
        replace: [
          "packages/aldus-stage-runner/src/runner.ts",
          'if (this.#stageSpendEvidence === undefined) return "indeterminate";',
          'if (this.#stageSpendEvidence === undefined) return "reserved_never_dispatched"; /* mutant */',
        ],
      },
    ],
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-stage-runner",
      "test/dispatch-evidence.test.ts",
    ],
    wantExit: 1,
    wantOutput: "emits it byte for byte",
  },
  {
    // Weakening the friction, which is the one thing this change must not do. The safe row is
    // evidence about a store, never permission: §19.1's concern is two runners executing one
    // side-effecting stage at once, and no verdict answers that question.
    name: "dispatch-evidence: letting the safe row skip --force removes the refusal entirely",
    setup: [
      {
        replace: [
          "packages/aldus-stage-runner/src/runner.ts",
          "      const evidence = await this.#dispatchEvidence(runId, definition.id);",
          '      const evidence = await this.#dispatchEvidence(runId, definition.id);\n      if (evidence === "reserved_never_dispatched") return; /* mutant */',
        ],
      },
    ],
    // Measured through the composed test rather than the runner's own, because that one's stuck
    // stage never returns: with the refusal gone the takeover *executes*, and the case would be
    // killed by a timeout — which is a non-answer wearing a failure's exit code. The composed
    // stage completes on its second claim, so the mutant fails an assertion instead.
    command: [
      "npx",
      "vitest",
      "run",
      "--root",
      "packages/aldus-services",
      "test/takeover-evidence-wiring.test.ts",
    ],
    wantExit: 1,
    wantOutput: "still refuses without --force, and still takes over with it",
  },
];
