/**
 * Generate the committed JSON Schema artifacts (ADR-0002).
 *
 *   node --experimental-strip-types scripts/generate-json-schema.ts           # write
 *   node --experimental-strip-types scripts/generate-json-schema.ts --check   # verify, no write
 *
 * `--check` is what CI runs: it regenerates in memory and exits non-zero if any committed file
 * differs, so a Zod schema edited without regenerating fails the build rather than shipping a
 * JSON Schema that describes an older contract.
 *
 * This script imports the BUILT output rather than `src/`. Node's type stripping does not
 * resolve a `.js` specifier to a `.ts` file, and the source uses `.js` specifiers throughout as
 * NodeNext requires — so `npm run build` must precede this script. The vitest drift test in
 * `test/json-schema.test.ts` checks the same invariant directly against `src/`, which is what
 * catches a stale `dist/`.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_FILE_NAMES, allJsonSchemas, serializeJsonSchema } from "../dist/json-schema.js";
import type { SchemaName } from "../dist/schema/index.js";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = join(packageRoot, "schema");
const checkOnly = process.argv.includes("--check");

const documents = allJsonSchemas();
const names = Object.keys(documents) as SchemaName[];

if (checkOnly) {
  const drifted: string[] = [];
  for (const name of names) {
    const fileName = SCHEMA_FILE_NAMES[name];
    const expected = serializeJsonSchema(documents[name]);
    let actual: string | undefined;
    try {
      actual = await readFile(join(outputDir, fileName), "utf8");
    } catch {
      drifted.push(`${fileName} (missing)`);
      continue;
    }
    if (actual !== expected) drifted.push(`${fileName} (stale)`);
  }

  if (drifted.length > 0) {
    console.error(
      `JSON Schema artifacts are out of date:\n  ${drifted.join("\n  ")}\n\n` +
        "Run `npm run schema:generate -w @aldus-runtime/core` and commit the result (ADR-0002).",
    );
    process.exit(1);
  }
  console.log(`JSON Schema artifacts are up to date (${names.length} schemas).`);
} else {
  await mkdir(outputDir, { recursive: true });
  for (const name of names) {
    await writeFile(join(outputDir, SCHEMA_FILE_NAMES[name]), serializeJsonSchema(documents[name]));
  }
  console.log(`Wrote ${names.length} JSON Schema artifacts to ${outputDir}.`);
}
