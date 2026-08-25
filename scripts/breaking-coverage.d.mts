/**
 * Types for the breaking-notes admission rule.
 *
 * Declared rather than suppressed: the alternative was a `@ts-expect-error` on the import, which
 * turns a typed test of a money-adjacent gate into an untyped one, and this repository's style
 * forbids casting around strictness rather than respecting it.
 */

/** The CHANGELOG section a tree's notes must live in. */
export declare function selectSection(
  changelog: string,
  version: string,
): { heading: string | undefined; body: string };

/** Waivers declared in one section, and any that are waiver-shaped but malformed. */
export declare function parseWaivers(sectionBody: string): {
  waived: Map<string, string>;
  malformed: string[];
};

/** Findings the section neither marks nor waives. */
export declare function uncoveredFindings(
  findings: readonly string[],
  sectionBody: string,
  waived: Map<string, string>,
): string[];
