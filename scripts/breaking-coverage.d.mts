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

export type DeclarationKind = "class" | "interface" | "type" | "function" | "const" | "enum";

/** Extract the declarations relevant to the breaking-notes check from one built `.d.ts`. */
export declare function declarationSurface(
  text: string,
  pkg: string,
): {
  surface: Map<string, Set<string>>;
  declarations: Map<string, DeclarationKind>;
  opaque: Map<string, string>;
};

/** Mechanical breaking findings between two extracted declaration surfaces. */
export declare function breakingFindings(
  base: Map<string, Set<string>>,
  head: Map<string, Set<string>>,
  baseDeclarations: Map<string, DeclarationKind>,
  headDeclarations: Map<string, DeclarationKind>,
): string[];
