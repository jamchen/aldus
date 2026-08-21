# Aldus — working agreement

## The contract

`docs/ALDUS-ARCHITECTURE.md` is the architecture contract. Read it before changing anything in
`packages/`. Normative terms (MUST / SHOULD / MAY) are used deliberately there.

`docs/adr/` records decisions the contract leaves open. If you need to decide something the
contract does not settle, choose the **smallest reversible option**, record the assumption, and
write an ADR if the choice shapes a public API.

## The boundary — the rule that matters most

Aldus Core is a **generic** production runtime. Contract §4.2 lists what Core does not own.
Concretely, nothing under `packages/` may contain:

- a show name, host persona, company, brand, or adopter identity;
- a TTS provider, voice ID, or model name (`elevenlabs`, `openai`, …);
- a publishing platform (`youtube`, `spotify`, `rss`, …);
- a cloud or storage service (`gcs`, `s3`, `firestore`, `drive`, …);
- an adopter-specific filename, path, or Markdown convention.

Provider- and platform-shaped concepts are represented as **opaque strings supplied by the
caller** (`provider: string`, `destination: string`, `kind: string`), never as enumerations
Core defines. Contract §4.3: the dependency direction is `Adopter Integration → Aldus public
contracts`, never the reverse.

Test fixtures use obviously fictional placeholders (`example-show`, `example-host`,
`provider-a`, `destination-a`). Private Knowledge Packs MUST never be required by Core tests
(§19.2).

**An adopter's identity does not belong in `docs/` either.** Provider and platform names appear in
`docs/` deliberately — §4.2 quotes "YouTube channel IDs" to state its own rule — but a specific
adopter's repository, product or company has no place in the record any more than in the runtime.
Where an adopter's case is the evidence, "the first adopter" carries the same substance.

`scripts/check-generic-boundary.mjs` enforces both, with the list in one place and a per-category
scope: provider/platform/cloud in `packages/`, adopter identity in `packages/` **and** `docs/`. CI
runs it and `packages/aldus-e2e/test/boundary.test.ts` runs the same script, so the local check and
the CI check cannot disagree.

The check it replaced was named "Reject adopter-specific names", said in its comment that it covered
adopter identity, contained none, and scanned `packages/` only — so two files reached `main` naming
an adopter, one of them in `docs/` (#173). A claim about a boundary has to be enforceable rather
than asserted, and a neutrality rule enforced by attention fails on the busiest day.

## Layout

```
packages/aldus-core/      @aldus-runtime/core     domain types, schemas, validation, IDs, redaction
packages/aldus-testkit/   @aldus-runtime/testkit  deterministic builders, fixtures, test doubles
docs/adr/                                 architecture decision records
```

Package placement rationale: ADR-0001.

## Commands

```bash
npm install
npm run verify           # format:check + build + schema:check + test — run before every commit
npm run build            # tsc -b across the workspace
npm test                 # vitest in every package
npm run schema:generate  # regenerate packages/aldus-core/schema/*.schema.json
npm run schema:check     # fail if committed JSON Schema is stale
npm run format           # prettier --write
```

## The contract is executable

`packages/aldus-core/test/contract-conformance.test.ts` parses the TypeScript declarations out
of `docs/ALDUS-ARCHITECTURE.md` and checks the implemented schemas against them: every declared
field present, optionality preserved, and no unlisted additions.

So a schema change that departs from the contract fails CI. If the departure is intended, add
it to `SANCTIONED_ADDITIONS` in that test **and** justify it in an ADR or the work-package
issue. If the contract itself changed, the test starts failing until the schema follows.

## Schemas

Zod definitions in `packages/aldus-core/src/schema/` are the single source of truth. TypeScript
types are inferred from them; JSON Schema files in `packages/aldus-core/schema/` are generated
and committed. **After changing any Zod schema, run `npm run schema:generate` and commit the
result** — CI fails on drift. Rationale: ADR-0002.

Schema version is a single package-wide `SCHEMA_VERSION` (`MAJOR.MINOR`). Adding an optional
field is a MINOR bump; anything else is MAJOR. Rationale: ADR-0003.

## Security invariants

- Validation errors carry the failing **path and issue code only, never the received value**
  (§19.2). If you add an error path, keep it value-free.
- Anything that could reach a log goes through `redact()` first.
- Secrets are referenced, never embedded in manifests, errors, or fixtures.

## Check the mechanism, not its description

Four defects in two days shared one mechanism, and it is worth stating separately from any of them
because each looked like an isolated lapse:

| the description                 | the mechanism                                               |
| ------------------------------- | ----------------------------------------------------------- |
| `absenceIsReadable`             | equivalent to `true`                                        |
| "test-harness-only"             | a published surface (`RecordingReleaseAdapter` is exported) |
| "all genuinely clean"           | trial-merged against the wrong base                         |
| "Reject adopter-specific names" | a regex holding no adopter name                             |

**In every one the description was checked and the mechanism was not.** Nobody re-read the regex
against the sentence above it. A name, a comment and a claim are all easier to read than the code
under them, and they are read first — so a mechanism that has drifted from its description keeps
passing review for as long as reviewers read the description.

Two habits that catch this cheaply, both earned rather than invented:

- **Before describing a change's blast radius** — _test-only_, _docs-only_, _additive_ — check the
  **export surface**, not the file path. Three of the four above would have fallen to that question
  alone.
- **Before claiming a measurement**, ask what was measured, with what, and whether it answers the
  question the claim is about. "All genuinely clean" was true of what was measured and false of
  what it was taken to mean; so were "trivial" and "test-harness-only".

A corollary about instruments. A harness that lies is found by someone else; an instrument that
lies is only ever found by the person holding it — so the check has to be habitual rather than
triggered by suspicion. And an invalid measurement that happens to **agree with a plausible worry**
is the hardest to discard, because discarding it feels like refusing evidence. Establish the
instrument is sound before believing what it says.

## Style

- ESM only, `NodeNext` resolution, explicit `.js` extensions on relative imports.
- `strict` plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — respect them
  rather than casting around them. No `any`; use `unknown` and narrow.
- Every exported symbol carries a TSDoc comment that names the contract section it implements.
- Tests are colocated per package under `test/`, named `<unit>.test.ts`.

## Scope discipline

Work is tracked as Work Packages (contract §22), one GitHub issue each. Implement only the WP
you were assigned. If you find something a later WP needs, note it in the issue — do not
implement ahead.
