# ADR-0002: Schema authoring and validation stack

- Status: Accepted
- Date: 2026-08-18
- Closes: architecture contract §25 item 2 (validator half; migration mechanism is ADR-0003)
- Relates to: §6 Domain model, §11 stage input/output validation, §19.2 Security

## Context

WP-01 must deliver "TypeScript domain types; JSON schemas and validators". Those are two
artifacts describing one contract, so the design question is which one is authoritative.

Constraints from the architecture contract:

- §11: every stage MUST validate declared inputs and produce declared outputs or a structured
  failure. Validation is on the hot path of every stage, not a build-time lint.
- §19.2: logs MUST redact credentials. A validator that echoes rejected input values into an
  error message is a credential-leak vector.
- §4.2 / §21: Core must stay generic and must not acquire heavy or opinionated dependencies.
- The runtime is intended to be independently open-sourceable, and §18 exposes a CLI and MCP
  surface. Non-TypeScript consumers must be able to read the contract.

Two artifacts drifting apart is the dominant failure mode: hand-writing both a `.ts` interface
and a `.schema.json` means every field change is two edits, and nothing fails when only one is
made.

## Decision

1. **Zod 4 schema definitions are the single source of truth.** TypeScript types are derived
   with `z.infer`, and are re-exported as named interfaces so consumers import types, not
   schema objects.
2. **JSON Schema is generated, not authored.** `z.toJSONSchema()` emits JSON Schema draft
   2020-12 into `packages/aldus-core/schema/*.schema.json`. Generated files are **committed**,
   so the contract is readable in the repository and by non-TypeScript consumers without a
   build step.
3. **Drift is a CI failure.** `npm run schema:check` regenerates in memory and fails if the
   committed files differ. A field added to a Zod schema without regenerating breaks the build.
4. **Ajv is a test-only dependency.** A conformance test loads the committed JSON Schema files
   into Ajv (2020-12 + `ajv-formats`) and compares its verdict against Zod's on every fixture.
   The assertion is deliberately asymmetric, because the emitted schema is knowably weaker than
   the Zod schema (see Consequences):

   - every **valid** fixture MUST pass both Zod and Ajv — no exceptions;
   - every **invalid** fixture MUST fail Zod (Zod is normative);
   - an invalid fixture additionally declares `jsonSchemaDetectable: true | false`. `true`
     means Ajv MUST also reject it; `false` means the violation is a Zod refinement that JSON
     Schema cannot express, and Ajv is expected to accept it.

   This turns each gap between the two representations into an explicit, reviewed declaration
   rather than a silent weakening. Ajv is **not** a runtime dependency of Core.

5. **`additionalProperties` is stripped from the emitted schema.** `z.toJSONSchema()` emits
   `"additionalProperties": false` for `z.object()` by default, which would make a
   non-TypeScript reader _reject_ a record written by a newer minor version — the opposite of
   the forward-compatibility rule in ADR-0003. The generator therefore removes the keyword from
   every object node via `toJSONSchema`'s `override` hook, so both validators ignore unknown
   properties instead of rejecting them.
6. **Validation failures return a `StructuredError`, never a thrown Zod error.** The
   `validate()` API returns a discriminated result. Error details carry the failing **path and
   issue code only — never the received value**, satisfying §19.2 without relying on a
   downstream redaction step.
7. **Objects are non-strict on read.** Unknown properties are ignored rather than rejected, so
   a record written by a newer minor schema version stays readable (see ADR-0003). Zod's strip
   behaviour means unknown properties are _dropped_ from the parsed value, not preserved. That
   is acceptable for validation; whether a store must preserve them across a read-modify-write
   cycle is a WP-02 concern and is recorded as an open question, not decided here.

## Consequences

- One edit per field change; drift is mechanically impossible to merge.
- Core gains exactly one runtime dependency (`zod`). §4.2 forbids provider/platform
  dependencies; a schema library is neither, and it is replaceable because it is reached only
  through `validate()` / `assertValid()` and the schema registry.
- The generated JSON Schema is constrained by what `z.toJSONSchema()` can express. Cross-field
  refinements are **silently dropped** during emission — verified: a `.refine()` requiring "at
  least one of `estimated`/`actual`" produces a schema with no trace of the constraint. The
  emitted schema is therefore _weaker_ than the Zod schema wherever a refinement exists.
  Decision 4's `jsonSchemaDetectable` flag makes each such gap explicit in a fixture, and the
  constraint is restated in the schema's `description` so a non-TypeScript consumer can see it.
  **Zod is the normative validator; the JSON Schema is a faithful-but-weaker projection.**
- Swapping validators later means rewriting schema definitions once and regenerating; consumers
  bound to `validate()` and to the committed `.schema.json` files are unaffected.

## Alternatives considered

- **Hand-written JSON Schema + Ajv as the runtime validator.** Rejected: TypeScript types would
  have to be hand-written or code-generated, and Ajv error objects include the received value
  by default, which is a §19.2 hazard on every validation failure.
- **TypeScript interfaces as the source, JSON Schema generated by `ts-json-schema-generator`.**
  Rejected: gives no runtime validator at all, so §11 would need a second mechanism.
- **Zod only, no JSON Schema.** Rejected: §18 exposes CLI and MCP surfaces and the runtime is
  meant to be open-sourceable; a TypeScript-only contract locks out other implementations.
