/**
 * Fixture builders for the regression harness.
 *
 * Everything here is fictional. Contract §19.2 requires that private Knowledge Packs never be
 * needed by tests or distributions, and §4.2 forbids naming a provider, platform, or show — so
 * the corpus talks about `example-show`, `example-host`, and `voice-a`.
 */

import type { ActorRef } from "@aldus-runtime/core";

import type { DefectCase, DefectCorpus, EvaluatorOutcome, EvaluatorRun } from "../src/corpus.js";
import { defaultPromotionPolicy, type PromotionPolicy } from "../src/policy.js";

export const LABELLER_A: ActorRef = { kind: "human", id: "labeller-a" };
export const LABELLER_B: ActorRef = { kind: "human", id: "labeller-b" };

/** Weights for the fictional severity scale used throughout these tests. */
export const SEVERITY_WEIGHTS = { minor: 1, major: 4, critical: 20 };

export function policy(
  overrides: Parameters<typeof defaultPromotionPolicy>[1] = {},
): PromotionPolicy {
  return defaultPromotionPolicy(SEVERITY_WEIGHTS, overrides);
}

/** A policy with tiny thresholds, so a test can exercise metrics without a 50-case fixture. */
export function lenientPolicy(
  overrides: Parameters<typeof defaultPromotionPolicy>[1] = {},
): PromotionPolicy {
  return defaultPromotionPolicy(SEVERITY_WEIGHTS, {
    thresholds: {
      minCases: 2,
      minDefectiveCases: 1,
      minCleanCases: 1,
      minRecall: 0.9,
      minSeverityWeightedRecall: 0.9,
      maxFalsePositiveRate: 0.2,
      maxUnnecessaryCorrectionHarm: 1,
      minLabellers: 1,
    },
    ...overrides,
  });
}

export interface CaseSpec {
  id: string;
  scope: Record<string, string>;
  defective: boolean;
  severity?: string;
  category?: string;
  correctionOnFlag?: string;
  labelledBy?: ActorRef;
}

export function aCase(spec: CaseSpec): DefectCase {
  const base = {
    caseId: spec.id,
    subjectRef: `artifact://${spec.id}`,
    scope: spec.scope,
    defective: spec.defective,
    findings: spec.defective
      ? [
          {
            category: spec.category ?? "semantic/unsupported-claim",
            severity: spec.severity ?? "major",
          },
        ]
      : [],
    labelledBy: spec.labelledBy ?? LABELLER_A,
    labelledAt: "2026-01-01T00:00:00.000Z",
  };
  const withSeverity = spec.defective ? { ...base, severity: spec.severity ?? "major" } : base;
  return (
    spec.correctionOnFlag === undefined
      ? withSeverity
      : { ...withSeverity, correctionOnFlag: spec.correctionOnFlag }
  ) as DefectCase;
}

export function aCorpus(cases: DefectCase[], corpusId = "corpus-a"): DefectCorpus {
  return { schemaVersion: "1.0", corpusId, cases };
}

export function anOutcome(caseId: string, flagged: boolean, category?: string): EvaluatorOutcome {
  return {
    caseId,
    flagged,
    findings: flagged ? [{ category: category ?? "semantic/unsupported-claim" }] : [],
  };
}

export function aRun(outcomes: EvaluatorOutcome[], corpusId = "corpus-a"): EvaluatorRun {
  return {
    schemaVersion: "1.0",
    evaluatorId: "evaluator-a",
    evaluatorVersion: "1.0.0",
    corpusId,
    outcomes,
    executedAt: "2026-01-02T00:00:00.000Z",
  };
}

/**
 * Build `count` cases in one scope, alternating defective and clean.
 *
 * `missEvery` makes the evaluator miss every Nth defective case, and `falseFlagEvery` makes it
 * spuriously flag every Nth clean case, so a test can dial a slice to either side of a bar.
 */
export function scenario(options: {
  scope: Record<string, string>;
  defective: number;
  clean: number;
  prefix: string;
  missEvery?: number;
  falseFlagEvery?: number;
  severity?: string;
  correctionOnFlag?: string;
  labelledBy?: ActorRef;
}): { cases: DefectCase[]; outcomes: EvaluatorOutcome[] } {
  const cases: DefectCase[] = [];
  const outcomes: EvaluatorOutcome[] = [];

  for (let index = 0; index < options.defective; index += 1) {
    const id = `${options.prefix}-d${index}`;
    cases.push(
      aCase({
        id,
        scope: options.scope,
        defective: true,
        ...(options.severity === undefined ? {} : { severity: options.severity }),
        ...(options.correctionOnFlag === undefined
          ? {}
          : { correctionOnFlag: options.correctionOnFlag }),
        ...(options.labelledBy === undefined ? {} : { labelledBy: options.labelledBy }),
      }),
    );
    const missed = options.missEvery !== undefined && index % options.missEvery === 0;
    outcomes.push(anOutcome(id, !missed));
  }

  for (let index = 0; index < options.clean; index += 1) {
    const id = `${options.prefix}-c${index}`;
    cases.push(
      aCase({
        id,
        scope: options.scope,
        defective: false,
        ...(options.correctionOnFlag === undefined
          ? {}
          : { correctionOnFlag: options.correctionOnFlag }),
        ...(options.labelledBy === undefined ? {} : { labelledBy: options.labelledBy }),
      }),
    );
    const spurious = options.falseFlagEvery !== undefined && index % options.falseFlagEvery === 0;
    outcomes.push(anOutcome(id, spurious));
  }

  return { cases, outcomes };
}
