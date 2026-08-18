/**
 * Manifest parsing (architecture contract §9.1).
 *
 * Contract §9.1 writes its example manifest in YAML, but Aldus Core takes **no YAML
 * dependency**. §4.2 keeps adopter-shaped concerns out of Core, and a parser for one authoring
 * format is exactly that: an adopter that authors manifests in TOML, JSON5, or front-matter
 * should not have to fork Core, and an adopter that authors in JSON should not carry a YAML
 * parser it never uses.
 *
 * So JSON is parsed natively and every other format arrives through an injected
 * {@link ManifestSourceParser}. Adding YAML support is one function an adopter supplies.
 */

import { AldusError } from "../errors.js";
import { validateWith } from "../validate.js";
import { KnowledgeErrorCodes } from "./errors.js";
import { knowledgePackManifestSchema, type KnowledgePackManifest } from "./manifest.js";

/**
 * Decodes manifest source text into an untyped document.
 *
 * Returns the decoded document, or throws. The result is validated against
 * {@link knowledgePackManifestSchema} afterwards, so a parser is not responsible for shape.
 */
export type ManifestSourceParser = (source: string) => unknown;

/** Parse JSON manifest source. The only format Core supports without an injected parser. */
export const parseJsonManifestSource: ManifestSourceParser = (source) => JSON.parse(source);

/** Options for {@link parsePackManifest}. */
export interface ParseManifestOptions {
  /**
   * Decoder for the manifest source. Defaults to {@link parseJsonManifestSource}.
   *
   * Supply a YAML parser here to author manifests in the format contract §9.1 illustrates.
   */
  parser?: ManifestSourceParser;
  /** Path or identifier of the source, used only in error detail. */
  sourceRef?: string;
}

/**
 * Normalise a decoded manifest document before validation.
 *
 * One accommodation only: contract §9.1's own example writes `version: 1`, which both YAML and
 * JSON decode as a *number*, while `KnowledgePackRef.version` is a string and must stay one so
 * that a manifest and the reference snapshotted from it agree field-for-field. Coercing a
 * numeric version here means the contract's example parses as written, rather than the contract
 * being quietly wrong about its own format.
 *
 * The coercion is deliberately narrow: only `version`, and only when it is a finite number.
 * Nothing else is coerced, because lenient parsing hides authoring mistakes.
 */
export function normalizeManifestDocument(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return document;
  }
  const record = document as Record<string, unknown>;
  const version = record["version"];
  if (typeof version === "number" && Number.isFinite(version)) {
    return { ...record, version: String(version) };
  }
  return document;
}

/**
 * Parse and validate a Knowledge Pack manifest from source text (contract §9.1).
 *
 * @throws {AldusError} `ALDUS_KNOWLEDGE_MANIFEST_UNPARSEABLE` if the source cannot be decoded,
 * or `ALDUS_KNOWLEDGE_MANIFEST_INVALID` if the decoded document is not a valid manifest.
 */
export function parsePackManifest(
  source: string,
  options: ParseManifestOptions = {},
): KnowledgePackManifest {
  const parser = options.parser ?? parseJsonManifestSource;

  let decoded: unknown;
  try {
    decoded = parser(source);
  } catch (cause) {
    // The source text is NOT included in the error. A manifest is authored content, and §19.2
    // requires errors that reach a durable log to be safe; echoing an unparsed blob into one is
    // the kind of thing that leaks a pasted credential.
    throw new AldusError(
      KnowledgeErrorCodes.MANIFEST_UNPARSEABLE,
      "Knowledge Pack manifest source could not be decoded.",
      {
        category: "validation",
        details: {
          ...(options.sourceRef === undefined ? {} : { sourceRef: options.sourceRef }),
          parserError: cause instanceof Error ? cause.name : "unknown",
        },
      },
    );
  }

  return parsePackManifestDocument(decoded, options.sourceRef);
}

/**
 * Validate an already-decoded manifest document (contract §9.1).
 *
 * Use when manifests arrive as objects rather than text — from a {@link PackSource}, a test
 * fixture, or an adopter's own loader.
 *
 * @throws {AldusError} `ALDUS_KNOWLEDGE_MANIFEST_INVALID`.
 */
export function parsePackManifestDocument(
  document: unknown,
  sourceRef?: string,
): KnowledgePackManifest {
  const result = validateWith(knowledgePackManifestSchema, normalizeManifestDocument(document), {
    code: KnowledgeErrorCodes.MANIFEST_INVALID,
    subject: "KnowledgePackManifest",
  });
  if (result.ok) return result.value;

  const error = new AldusError(result.error.code, result.error.message, {
    category: result.error.category,
    retryable: result.error.retryable,
    details: {
      ...(result.error.details ?? {}),
      ...(sourceRef === undefined ? {} : { sourceRef }),
    },
  });
  throw error;
}
