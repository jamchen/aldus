/**
 * Contract conformance.
 *
 * `docs/ALDUS-ARCHITECTURE.md` is the architecture contract, and §6.1, §6.2, §6.3, §8, §13, and
 * §17 state field lists verbatim in TypeScript. Those declarations are normative, so this suite
 * parses them straight out of the document and checks the implemented schemas against them.
 *
 * The point is drift in either direction. A field removed from a schema fails here. A field
 * added to the contract and never implemented fails here. And an *unlisted* addition to a
 * schema fails here too, because the three deliberate additions are enumerated below — anything
 * else has to be argued for and added to that list, rather than appearing silently.
 *
 * This is the only test that reads the contract document. It is deliberately mechanical: it
 * cannot tell whether a type means the right thing, only whether the field list and its
 * optionality still match what the contract says.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { allJsonSchemas } from "../src/json-schema.js";
import type { SchemaName } from "../src/schema/index.js";

const contractPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "docs",
  "ALDUS-ARCHITECTURE.md",
);

interface ContractField {
  name: string;
  optional: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Extract every `interface X { … }` declared in the contract's TypeScript blocks. */
function parseContractInterfaces(markdown: string): Map<string, ContractField[]> {
  const interfaces = new Map<string, ContractField[]>();
  const declaration = /interface\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(markdown)) !== null) {
    const name = match[1];
    const body = match[2];
    if (name === undefined || body === undefined) continue;
    const fields = [...body.matchAll(/^\s*(\w+)(\??):/gm)].flatMap<ContractField>((field) => {
      const fieldName = field[1];
      return fieldName === undefined ? [] : [{ name: fieldName, optional: field[2] === "?" }];
    });
    if (fields.length > 0) interfaces.set(name, fields);
  }
  return interfaces;
}

/**
 * Fields present in a schema but not in the contract's own declaration.
 *
 * Each is justified in GitHub issue #1 and in ADR-0003. Adding to this list is a deliberate act:
 * it means departing from the contract's literal text, and the reason belongs in the ADR before
 * the entry belongs here.
 */
const SANCTIONED_ADDITIONS: Partial<Record<SchemaName, readonly string[]>> = {
  // ADR-0003: persisted as a standalone document, so it carries its own version.
  // `decisionId`: §6 shows ProductionRun 1→many GateDecision; without an ID two decisions on
  // one gate are indistinguishable.
  GateDecision: ["schemaVersion", "decisionId"],
  // ADR-0003 plus §6: ReleaseReceipt is a child of a Run, and lineage queries need the edge.
  //
  // `bundleId`: added at SCHEMA_VERSION 1.4 (ADR-0033). §17 describes a bundle as something a
  // caller assembles, and nothing stores one — so a receipt could name the Run and the
  // destination but never which release produced it, and two releases of one Run were
  // indistinguishable afterwards. Optional, and deliberately absent from the idempotency key:
  // keying on it is what made a reconstructed bundle re-execute every operation (#40).
  ReleaseReceipt: ["schemaVersion", "runId", "bundleId"],
  // ADR-0026, both added at SCHEMA_VERSION 1.3.
  //
  // `goalStages`: §6.2 gives a Run a status but nothing that says what reaching the end would
  // mean. A workflow graph describes what a workflow *can* do and cannot say what one Run set
  // out to do — a stage may be conditional on the edition, and a Run may deliberately stop
  // short of publishing. Completion is therefore declared intent, per Run.
  //
  // `cancellation`: §6.2's status enum includes `cancelled` but the contract gives no field
  // recording who abandoned a Run or when. It is the one state that cannot be derived, because
  // §5.1 makes long pauses ordinary and silence in an append-only log says nothing about intent.
  RunManifest: ["goalStages", "cancellation"],
};

/** Types whose field list the contract states verbatim. */
const VERBATIM_TYPES: readonly SchemaName[] = [
  "EpisodeRef",
  "RunManifest",
  "StageAttempt",
  "ArtifactRef",
  "GateDecision",
  "ReleaseReceipt",
];

const contract = parseContractInterfaces(readFileSync(contractPath, "utf8"));
const documents = allJsonSchemas();

describe("architecture contract conformance", () => {
  it("finds the contract document and its interface declarations", () => {
    // If the document moves or its code fences change shape, every assertion below would pass
    // vacuously. Fail loudly instead.
    expect(contract.size).toBeGreaterThanOrEqual(VERBATIM_TYPES.length);
  });

  describe.each(VERBATIM_TYPES)("%s", (name) => {
    const fields = contract.get(name);
    const document = documents[name];
    // JsonSchemaDocument is Record<string, unknown>, so these two keys need narrowing before
    // use. Narrow explicitly rather than casting: an emitted document that unexpectedly lacks
    // `properties` or `required` should surface as an empty list here and fail the assertion
    // below, not as a runtime type error inside the check.
    const properties = Object.keys(isRecord(document.properties) ? document.properties : {});
    const required = new Set(isStringArray(document.required) ? document.required : []);

    it("is declared in the contract", () => {
      expect(fields, `${name} is no longer declared in the architecture contract`).toBeDefined();
    });

    it("implements every field the contract declares", () => {
      const missing = (fields ?? []).filter((field) => !properties.includes(field.name));
      expect(missing.map((field) => field.name)).toEqual([]);
    });

    it("preserves the optionality the contract declares", () => {
      const mismatched = (fields ?? [])
        .filter((field) => properties.includes(field.name))
        .filter((field) => field.optional === required.has(field.name))
        .map(
          (field) =>
            `${field.name}: contract says ${field.optional ? "optional" : "required"}, schema says ${
              required.has(field.name) ? "required" : "optional"
            }`,
        );
      expect(mismatched).toEqual([]);
    });

    it("adds no field beyond those sanctioned in issue #1", () => {
      const declared = new Set((fields ?? []).map((field) => field.name));
      const sanctioned = new Set(SANCTIONED_ADDITIONS[name] ?? []);
      const unsanctioned = properties.filter(
        (property) => !declared.has(property) && !sanctioned.has(property),
      );
      expect(unsanctioned).toEqual([]);
    });
  });
});
