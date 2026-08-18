/**
 * The TTS lexicon (architecture contract §15.2).
 *
 * §15.2 lists what an entry supports: written and spoken forms; scope by show, host, provider,
 * voice, model, language, and script form; authority and approval status; risk-site annotations;
 * examples and regression fixtures; provenance and version.
 *
 * Scope is the part that needs care. §15.2 names seven dimensions, but three of them — provider,
 * voice, model — are exactly the things §4.2 forbids the runtime from naming, and an adopter will
 * want dimensions the contract never listed. So scope is a caller-supplied string map throughout,
 * the same decision WP-09 made for Knowledge Pack scope and for the same reason.
 *
 * Resolution mirrors WP-09's model deliberately: most specific wins, authority outranks
 * specificity, and a genuine tie between normative entries is **reported, never merged** (§9.2:
 * "Conflicts MUST be detectable. Silent last-write-wins behavior SHOULD be avoided for normative
 * rules."). An operator who has written two contradictory pronunciation rules needs to be told,
 * not to have one silently chosen.
 */

import { z } from "zod";

import {
  iso8601,
  nonEmptyString,
  schemaVersionPattern,
  scopeDimensions,
  sha256Hex,
} from "./common.js";
import type { ScopeDimensions } from "./common.js";
import { TtsLedgerErrorCodes, ttsLedgerError } from "./errors.js";

/**
 * How binding an entry is (contract §9.1, §15.2).
 *
 * The same vocabulary WP-09 uses for Knowledge Pack authority. Sharing it is not incidental: a
 * lexicon is Knowledge Pack content (§9 lists a Provider Pack's "tag mapping" and a Quality Pack's
 * "lint rules"), and two different meanings of "normative" in one system would be a trap.
 */
export const LEXICON_AUTHORITIES = ["normative", "advisory", "example", "deprecated"] as const;

/** @see LEXICON_AUTHORITIES */
export type LexiconAuthority = (typeof LEXICON_AUTHORITIES)[number];

/** Whether an entry has been approved for use (contract §15.2). */
export const LEXICON_APPROVAL_STATUSES = ["proposed", "approved", "retired"] as const;

/** @see LEXICON_APPROVAL_STATUSES */
export type LexiconApprovalStatus = (typeof LEXICON_APPROVAL_STATUSES)[number];

/** A worked example or regression fixture for an entry (contract §15.2). */
export const lexiconExampleSchema = z
  .object({
    /** Context the entry applies in. */
    context: z.string().max(2000),
    /** What the entry should produce. */
    expectedSpoken: z.string().max(2000),
    /** Path to a fixture, recorded and resolved but never parsed here (contract §9.1, §1.2). */
    fixtureRef: z.string().min(1).max(1000).optional(),
  })
  .meta({
    id: "LexiconExample",
    title: "LexiconExample",
    description:
      "A worked example or regression fixture for a lexicon entry (architecture contract §15.2). " +
      "`fixtureRef` is a path the runtime records and resolves but never parses — §1.2 rules out " +
      "converting production knowledge into a database.",
  });

/** @see lexiconExampleSchema */
export type LexiconExample = z.infer<typeof lexiconExampleSchema>;

/** One pronunciation rule (contract §15.2). */
export const lexiconEntrySchema = z
  .object({
    /** Schema version of this record (ADR-0003). */
    schemaVersion: schemaVersionPattern,
    /** Identity of this entry. Referenced by `PerformanceSegment.pronunciationRefs`. */
    entryId: nonEmptyString,
    /** The form as written in narration (contract §15.2). */
    written: z.string().min(1).max(1000),
    /**
     * How it should be spoken (contract §15.2).
     *
     * A plain string, not a phonetic alphabet. §14.1 keeps the performance layer independent of
     * provider syntax, and phonetic notation is provider- and voice-specific — a provider adapter
     * that wants IPA or a proprietary phoneme set carries it in `notation`.
     */
    spoken: z.string().min(1).max(1000),
    /** Which notation `spoken` is written in, if not plain orthography. Opaque (§4.2). */
    notation: z.string().min(1).max(100).optional(),
    /** @see scopeDimensions */
    scope: scopeDimensions.optional(),
    /** @see LEXICON_AUTHORITIES */
    authority: z.enum(LEXICON_AUTHORITIES),
    /** @see LEXICON_APPROVAL_STATUSES */
    approvalStatus: z.enum(LEXICON_APPROVAL_STATUSES),
    /** Risk annotations attached to this entry (contract §15.2). */
    riskNotes: z.array(z.string().min(1).max(2000)).max(50).optional(),
    /** Examples and regression fixtures (contract §15.2). */
    examples: z.array(lexiconExampleSchema).max(200).optional(),
    /** Where the entry came from (contract §15.2 "provenance"). */
    sourceRevision: z.string().min(1).max(200).optional(),
    /** Digest of the source it was read from, making a snapshot verifiable. */
    contentHash: sha256Hex.optional(),
    /** Entry version (contract §15.2). An opaque string; adopters version how they like. */
    version: nonEmptyString,
    /** When this revision was recorded. */
    updatedAt: iso8601.optional(),
  })
  .meta({
    id: "LexiconEntry",
    title: "LexiconEntry",
    description:
      "One pronunciation rule (architecture contract §15.2). Scope dimensions are caller-supplied " +
      "strings, never an enumeration: §15.2 names provider, voice, and model among them, and §4.2 " +
      "forbids the runtime from naming any. `spoken` is plain text by default because phonetic " +
      "notation is provider-specific and §14.1 keeps this layer independent of provider syntax.",
  });

/** @see lexiconEntrySchema */
export type LexiconEntry = z.infer<typeof lexiconEntrySchema>;

/** A context to resolve the lexicon against: the scope a particular synthesis happens in. */
export type LexiconContext = ScopeDimensions;

/** Two or more normative entries claiming one written form at equal specificity (contract §9.2). */
export interface LexiconConflict {
  /** The written form they disagree about. */
  written: string;
  /** How specific the tied entries are. */
  specificity: number;
  /** The entries that tied. */
  entries: LexiconEntry[];
  /** Operator-facing explanation. */
  explanation: string;
}

/** The outcome of resolving the lexicon for one context. */
export interface LexiconResolution {
  /** The winning entry for each written form, keyed by written form. */
  winners: Map<string, LexiconEntry>;
  /** Ties between normative entries, which are reported and never resolved (contract §9.2). */
  conflicts: LexiconConflict[];
  /** Entries excluded because their scope does not match the context. */
  outOfScope: LexiconEntry[];
  /** Entries excluded because they are deprecated or retired, kept for discoverability (§9.3). */
  excluded: LexiconEntry[];
}

/**
 * Whether an entry's scope applies to a context.
 *
 * An entry applies when every dimension it declares matches. An entry declaring nothing is global
 * and applies everywhere; a context dimension the entry says nothing about does not disqualify it.
 * That asymmetry is what makes a global rule a global rule.
 */
export function scopeMatches(entry: LexiconEntry, context: LexiconContext): boolean {
  const scope = entry.scope ?? {};
  return Object.entries(scope).every(([dimension, value]) => context[dimension] === value);
}

/**
 * How specific an entry is: the number of scope dimensions it constrains.
 *
 * Counting dimensions rather than ranking them is deliberate. §15.2 lists seven dimensions
 * without ordering them, and any ordering this package invented would be a guess that silently
 * decided which of two rules wins — the class of failure §9.2 asks to be made detectable. An
 * adopter that needs an ordering supplies explicit entries at the specificity it wants.
 */
export function specificityOf(entry: LexiconEntry): number {
  return Object.keys(entry.scope ?? {}).length;
}

/** Authority ranking, most binding first. Mirrors WP-09's precedence model (ADR-0006). */
const AUTHORITY_RANK: Record<LexiconAuthority, number> = {
  normative: 0,
  advisory: 1,
  example: 2,
  deprecated: 3,
};

/**
 * Resolve the lexicon for one synthesis context (contract §15.2, §9.2).
 *
 * Returns a report rather than throwing, for the reason ADR-0006 gives: an ambiguous rule set is
 * an operational condition an operator needs to *see*, and a caller forced into try/catch to
 * learn something it must display has been handed the wrong shape.
 *
 * Ordering is authority first, then specificity, then `entryId` for stability. Authority outranks
 * specificity for the reason ADR-0006 settled for packs: an `example` entry scoped to one episode
 * must not override a `normative` global rule merely by being more specific, or an illustration
 * becomes more binding than a rule.
 */
export function resolveLexicon(
  entries: readonly LexiconEntry[],
  context: LexiconContext,
): LexiconResolution {
  const winners = new Map<string, LexiconEntry>();
  const conflicts: LexiconConflict[] = [];
  const outOfScope: LexiconEntry[] = [];
  const excluded: LexiconEntry[] = [];

  const byWritten = new Map<string, LexiconEntry[]>();
  for (const entry of entries) {
    // Deprecated and retired entries never win, but they stay in the report: §9.3 wants
    // superseded guidance discoverable, which is not the same as letting it apply.
    if (entry.authority === "deprecated" || entry.approvalStatus === "retired") {
      excluded.push(entry);
      continue;
    }
    if (!scopeMatches(entry, context)) {
      outOfScope.push(entry);
      continue;
    }
    const bucket = byWritten.get(entry.written);
    if (bucket === undefined) byWritten.set(entry.written, [entry]);
    else bucket.push(entry);
  }

  for (const [written, candidates] of byWritten) {
    const ranked = [...candidates].sort((a, b) => {
      const authority = AUTHORITY_RANK[a.authority] - AUTHORITY_RANK[b.authority];
      if (authority !== 0) return authority;
      const specificity = specificityOf(b) - specificityOf(a);
      if (specificity !== 0) return specificity;
      return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
    });

    const winner = ranked[0];
    if (winner === undefined) continue;
    winners.set(written, winner);

    // Only a tie among *normative* entries is a conflict. §9.2 scopes its requirement to
    // normative rules, and a normative entry beating an advisory one is an ordinary resolution
    // — reporting it would turn the conflict list into noise an operator learns to ignore.
    if (winner.authority !== "normative") continue;
    const tied = ranked.filter(
      (entry) => entry.authority === "normative" && specificityOf(entry) === specificityOf(winner),
    );
    if (tied.length > 1) {
      conflicts.push({
        written,
        specificity: specificityOf(winner),
        entries: tied,
        explanation:
          `${tied.length} normative lexicon entries claim "${written}" at the same specificity ` +
          `(${tied.map((entry) => entry.entryId).join(", ")}). Architecture contract §9.2 requires ` +
          "conflicts to be detectable and forbids silent last-write-wins for normative rules, so " +
          "none was applied. Narrow one entry's scope or demote it to advisory.",
      });
    }
  }

  return { winners, conflicts, outOfScope, excluded };
}

/**
 * Resolve, and refuse if any normative rules conflict.
 *
 * The throwing form, for a caller about to *act* on the lexicon rather than display it —
 * substituting text under an unresolved contradiction would bake one arbitrary reading into paid
 * audio.
 *
 * @throws {AldusError} `ALDUS_TTS_LEXICON_CONFLICT`
 */
export function requireLexicon(
  entries: readonly LexiconEntry[],
  context: LexiconContext,
): Map<string, LexiconEntry> {
  const resolution = resolveLexicon(entries, context);
  if (resolution.conflicts.length > 0) {
    throw ttsLedgerError(
      TtsLedgerErrorCodes.LEXICON_CONFLICT,
      resolution.conflicts.map((conflict) => conflict.explanation).join(" "),
      {
        category: "conflict",
        retryable: false,
        details: {
          conflicts: resolution.conflicts.map((conflict) => ({
            written: conflict.written,
            entryIds: conflict.entries.map((entry) => entry.entryId),
          })),
        },
      },
    );
  }
  return resolution.winners;
}
