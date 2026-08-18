/**
 * Scope slicing (architecture contract §12.1).
 *
 * §12.1 lists "show, host, voice, model, and script-form scope" among what evaluator promotion
 * must consider. The reason is that calibration does not generalise: an evaluator tuned on one
 * host's cadence says nothing about another's, and one calibrated on a single voice says nothing
 * about a second voice's artefacts.
 *
 * So a corpus is sliced, and every metric is computed per slice. Dimensions are caller-supplied
 * `Record<string, string>` throughout, consistent with Knowledge Pack scope (§9.2, ADR-0006) —
 * §12.1's list is illustrative and §4.2 forbids Core from naming a provider.
 */

import type { ScopeDimensions } from "./corpus.js";

/**
 * A slice of the corpus: which dimensions were held fixed, and at what values.
 *
 * `dimensions` is empty for the whole-corpus slice, which is why that slice is named rather than
 * left implicit — see {@link WHOLE_CORPUS_SLICE}.
 */
export interface ScopeSelector {
  /** Dimension names held fixed by this slice, sorted. */
  dimensions: readonly string[];
  /** Value of each held dimension. */
  values: Readonly<Record<string, string>>;
}

/** The selector matching every case: no dimension held fixed. */
export const WHOLE_CORPUS_SLICE: ScopeSelector = { dimensions: [], values: {} };

/**
 * Stable string key for a selector, for grouping and for report ordering.
 *
 * Dimensions are sorted before joining so `{host,voice}` and `{voice,host}` produce one key.
 * Values are separated by a character that cannot appear in a dimension name.
 */
export function scopeKey(selector: ScopeSelector): string {
  if (selector.dimensions.length === 0) return "*";
  return [...selector.dimensions]
    .sort()
    .map((dimension) => `${dimension}=${selector.values[dimension] ?? ""}`)
    .join(" & ");
}

/** Human-readable label for a selector. */
export function scopeLabel(selector: ScopeSelector): string {
  return selector.dimensions.length === 0 ? "whole corpus" : scopeKey(selector);
}

/** True if a case's scope satisfies a selector. */
export function scopeMatches(scope: ScopeDimensions, selector: ScopeSelector): boolean {
  return selector.dimensions.every((dimension) => scope[dimension] === selector.values[dimension]);
}

/** Every dimension name that appears anywhere in a set of scopes, sorted. */
export function observedDimensions(scopes: readonly ScopeDimensions[]): string[] {
  const names = new Set<string>();
  for (const scope of scopes) for (const key of Object.keys(scope)) names.add(key);
  return [...names].sort();
}

/**
 * Derive the selectors a corpus should be reported against.
 *
 * The default is **each observed dimension, sliced individually** — one slice per distinct
 * `host`, one per distinct `voice`, and so on. It deliberately does not default to the full
 * cross-product: with five dimensions a corpus would shatter into slices of one or two cases
 * each, and a metric over two cases is noise that reads like evidence.
 *
 * A caller that genuinely needs a joint slice — "this evaluator on this host *and* this voice" —
 * passes the grouping explicitly through `groupings`. That makes combinatorial slicing a
 * deliberate request rather than something that happens by accident.
 *
 * @param scopes every case's scope.
 * @param groupings dimension groupings to slice by. Defaults to each observed dimension alone.
 */
export function deriveScopeSelectors(
  scopes: readonly ScopeDimensions[],
  groupings?: readonly (readonly string[])[],
): ScopeSelector[] {
  const effective = groupings ?? observedDimensions(scopes).map((dimension) => [dimension]);
  const selectors = new Map<string, ScopeSelector>();

  for (const grouping of effective) {
    if (grouping.length === 0) continue;
    const dimensions = [...grouping].sort();
    for (const scope of scopes) {
      // A case that does not declare every dimension in the grouping is not in any slice of it.
      // Substituting a placeholder would invent a scope the labeller never asserted.
      if (dimensions.some((dimension) => scope[dimension] === undefined)) continue;
      const values: Record<string, string> = {};
      for (const dimension of dimensions) values[dimension] = scope[dimension] as string;
      const selector: ScopeSelector = { dimensions, values };
      selectors.set(scopeKey(selector), selector);
    }
  }

  return [...selectors.values()].sort((a, b) => scopeKey(a).localeCompare(scopeKey(b)));
}
