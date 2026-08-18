/**
 * Capabilities — the Production MCP's half of the §18.1 trust boundary.
 *
 * §18.1 draws a line that no other adapter has to observe:
 *
 * > Data-source MCP servers and production-control MCP servers MUST remain separate trust
 * > boundaries.
 * >
 * > - Read-oriented data tools MAY be broadly available.
 * > - Mutating production tools MUST validate workspace, Episode, Run, actor, permissions,
 * >   idempotency, and relevant approvals.
 * > - Paid synthesis and publishing operations MUST require explicit scoped authority.
 *
 * A CLI needs none of this: whoever holds the shell already holds the machine. An agent holding
 * an MCP session does not, and §10.1 says so directly — Claude Code must not be "implicitly
 * authorized to incur paid TTS cost" or "implicitly authorized to publish". *Implicitly* is the
 * operative word: the authority has to be granted somewhere an agent cannot reach, which means
 * at server construction, from host configuration, and never from a tool argument.
 *
 * These capabilities name **runtime operations**, not adopter concepts, which is why Core-side
 * code may enumerate them at all (§4.2). "May this caller start a Run" is a question about
 * Aldus; "may this caller publish to a particular destination" would be a question about an
 * adopter's platforms, and is deliberately not asked here.
 *
 * This layer is **additional to, never instead of**, the gate engine. Holding
 * {@link CAPABILITIES.spend} does not authorize spend — §13.2 still requires a hash-bound
 * `GateDecision`, and WP-05 still evaluates it. It only decides whether this caller may attempt
 * the operation at all.
 */

import { AldusError } from "@aldus-runtime/core";

import { McpErrorCodes } from "./errors.js";

/**
 * Scoped authorities a caller may hold.
 *
 * Prefixed `aldus:` so a host merging capability lists from several MCP servers can tell whose
 * authority it is granting.
 */
export const CAPABILITIES = {
  /**
   * Read production state (contract §18.1 "read-oriented data tools MAY be broadly available").
   *
   * Broadly grantable by design: §24 promises an operator can see current state without
   * ceremony, and an agent that cannot read state is reduced to guessing — which is precisely
   * the session-memory dependence §3.4 forbids.
   */
  read: "aldus:read",
  /** Create a workspace or its Episode (contract §7, §6.1). */
  workspaceInit: "aldus:workspace:init",
  /** Start a Run (contract §6.2). */
  runStart: "aldus:run:start",
  /** Execute or re-attempt a stage (contract §11). */
  stageRun: "aldus:stage:run",
  /**
   * Take over a stage another runner has claimed (contract §19.1).
   *
   * Separate from {@link CAPABILITIES.stageRun} because ADR-0008 refuses auto-takeover
   * precisely so two runners cannot execute one side-effecting stage at once. Forcing is a
   * judgement about whether the other holder is really dead, and §19.1 places stale-run
   * detection with an operator or supervisor rather than with whoever asked to run the stage.
   */
  stageForce: "aldus:stage:force",
  /**
   * Record a gate decision (contract §3.6, §13).
   *
   * Holding this permits *recording* a decision; it never substitutes for one. §13.3 keeps
   * final performance approval human-owned, and the gate engine enforces which actor kinds may
   * decide which gates.
   */
  gateDecide: "aldus:gate:decide",
  /**
   * Attempt an operation that can incur provider cost (contract §13.2, §18.1, §19.3).
   *
   * Required for running a stage whose `CostPolicy.requiresAuthorization` is set. Granting it
   * does **not** authorize spend — §13.2's hash-bound authorization is still required and still
   * evaluated by the gate engine. This only decides whether the caller may reach the attempt.
   */
  spend: "aldus:spend",
  /**
   * Attempt an operation that reaches an external release destination (contract §17, §18.1).
   *
   * Required by every tool that executes or reconciles a release bundle. §18.1 names publishing
   * alongside paid synthesis as needing "explicit scoped authority", and §10.1 forbids an agent
   * from being *implicitly* authorized to publish — so this is granted in host configuration and
   * is unreachable from a tool argument.
   *
   * Reconciliation requires it as well as execution. Reconciliation cannot publish, but it
   * contacts external destinations and rewrites the release record, and a wrong repair makes the
   * next execution skip an operation that never happened. The conservative side of that question
   * is the correct one when the adjacent operation is publishing; an operator who only wants to
   * *see* release state has `aldus_release_status` and `aldus_release_bundle_status`, neither of
   * which touches an adapter.
   *
   * Holding it does not authorize a release. §13.4 still requires separate, hash-bound approvals
   * for uploading and for making public, and the gate engine still evaluates them.
   */
  publish: "aldus:publish",
  /**
   * Take archival custody of irreplaceable artifacts (contract §8.1).
   *
   * §8.1 requires irreplaceable artifacts to be archived **before** disposable working files are
   * cleaned, which makes archival the operation that decides whether a later cleanup is safe.
   * Separate from the artifact reads beside it because it copies bytes into a durable store: a
   * session that may inspect lineage is not thereby a session that may take custody.
   */
  artifactArchive: "aldus:artifact:archive",
  /**
   * Record performance and synthesis planning material (contract §14, §15).
   *
   * Covers recording a PerformanceScript and a synthesis request plan. Neither spends anything —
   * a plan is the thing an operator approves, so recording one is what makes authorization
   * possible rather than a substitute for it. Kept separate from {@link CAPABILITIES.spend} for
   * exactly that reason: preparing work an operator will judge is a smaller authority than
   * incurring cost, and collapsing them would force a host to grant spend authority to a session
   * that only drafts.
   */
  ttsRecord: "aldus:tts:record",
} as const;

/** @see CAPABILITIES */
export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES];

/** Every capability, for hosts building a configuration UI or a grant-all test double. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.values(CAPABILITIES);

/**
 * What a caller is permitted to attempt.
 *
 * Constructed once, from host configuration, and never mutated afterwards. A grant that could
 * be widened at runtime would let a tool call escalate the session it arrived on, which is the
 * shape of privilege escalation §18.1 separates trust boundaries to prevent.
 */
export class CapabilityGrant {
  readonly #granted: ReadonlySet<Capability>;

  constructor(granted: Iterable<Capability> = []) {
    this.#granted = new Set(granted);
  }

  /** A grant holding every capability. For tests and for a host that has decided to trust. */
  static all(): CapabilityGrant {
    return new CapabilityGrant(ALL_CAPABILITIES);
  }

  /** A grant holding only read authority — the §18.1 "broadly available" tier. */
  static readOnly(): CapabilityGrant {
    return new CapabilityGrant([CAPABILITIES.read]);
  }

  /** Whether this caller holds `capability`. */
  has(capability: Capability): boolean {
    return this.#granted.has(capability);
  }

  /** Granted capabilities, sorted for stable reporting. */
  list(): Capability[] {
    return [...this.#granted].sort();
  }

  /**
   * Refuse unless every required capability is held.
   *
   * The error names the missing capability and where it is granted, because the caller is an
   * agent that will otherwise retry the same call: an agent told only "not permitted" has no
   * way to learn that the remedy is host configuration rather than a different argument.
   *
   * @throws {AldusError} `ALDUS_MCP_CAPABILITY_REQUIRED`
   */
  assert(required: readonly Capability[], toolName: string): void {
    const missing = required.filter((capability) => !this.#granted.has(capability));
    if (missing.length === 0) return;

    throw new AldusError(
      McpErrorCodes.CAPABILITY_REQUIRED,
      `The tool "${toolName}" requires ${missing.map((c) => `"${c}"`).join(", ")}, which this ` +
        "session does not hold. Scoped authority is granted in the host's MCP server " +
        "configuration, never by a tool argument (architecture contract §18.1, §10.1) — so " +
        "retrying with different arguments cannot succeed.",
      {
        category: "policy",
        retryable: false,
        details: { tool: toolName, required: [...required], missing, granted: this.list() },
      },
    );
  }
}
