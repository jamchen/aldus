/**
 * The declined-invocation message shared by the release gate scripts.
 *
 * A check has three states and `DECLINED` is never folded into either other one — the costliest
 * failure in the #165–#171 series was a non-answer read as an answer. The gates already exited 2
 * for a missing or unusable argument, which is a correct declined signal, and printed a bare
 * `usage:` line, which is not: a reader — an agent especially — cannot tell "the gate ran and did
 * not like what it saw" from "the gate never ran" out of one usage line and a status code they
 * may not have captured.
 *
 * Exit 2 is unchanged. CI and ADR-0050 read these codes, so the fix is entirely in what the
 * message says: that this is a declined invocation, that it is neither a pass nor a failure, what
 * was wrong with the arguments, and one invocation that would work.
 *
 * The wording lives here rather than in each script because three scripts stating the same three
 * states in three spellings is how one of them drifts. Every message is built by `decline()`, so
 * a fourth caller cannot invent a fourth spelling by accident.
 *
 * Found by the independent review of PR #263; same defect class as issue #228. Extended to
 * `check-claim-scope.mjs`, which had the identical defect, by the independent review of PR #264.
 */

/**
 * Print a declined-invocation message and exit 2.
 *
 * The one place the three states are spelled. `headline` says what was wrong with this
 * invocation, `usage`/`example` show one that would work, and `notes` explains the arguments.
 *
 * @param {string} script - the script's filename, e.g. `check-version-bump.mjs`.
 * @param {string} headline - what was wrong, as a sentence ending in "so no gate ran."
 * @param {string} usage - the argument synopsis, e.g. `<base-ref>`.
 * @param {string} example - the arguments of a worked invocation, e.g. `origin/main`.
 * @param {string} notes - what the arguments mean; one or more lines, no trailing newline.
 * @returns {never}
 */
function decline(script, headline, usage, example, notes) {
  console.error(`DECLINED: ${headline}`);
  console.error("This is a declined invocation. It is NOT a gate pass and NOT a gate failure.\n");
  console.error(`usage: node scripts/${script} ${usage}`);
  console.error(`  e.g. node scripts/${script} ${example}\n`);
  console.error(
    `${notes}\nExit codes: 0 the gate passed, 1 the gate failed, 2 declined (no result).`,
  );
  process.exit(2);
}

/** What `<base-ref>` is, shared by every gate that takes one. */
const BASE_REF_NOTE =
  "<base-ref> is the ref this branch is compared against — normally the merge target.";

/**
 * Print the declined-invocation message for a gate invoked without a required argument, exit 2.
 *
 * `usage` is the gate's whole synopsis, not just the missing argument: a reader who left one of
 * two arguments off needs to see both, and a synopsis that names only the one they missed is how
 * the message drifts from the gate it describes.
 *
 * @param {string} script - the script's filename, e.g. `check-claim-scope.mjs`.
 * @param {string} argument - the missing argument, as the synopsis spells it, e.g. `<claim>`.
 * @param {string} usage - the gate's full argument synopsis, e.g. `<base-ref> <claim>`.
 * @param {string} example - the arguments of a worked invocation, e.g. `origin/main docs-only`.
 * @param {string} notes - what the arguments mean; one or more lines, no trailing newline.
 * @returns {never}
 */
export function declineMissingArgument(script, argument, usage, example, notes) {
  decline(
    script,
    `${script} was invoked with no ${argument} argument, so no gate ran.`,
    usage,
    example,
    notes,
  );
}

/**
 * Print the declined-invocation message for a gate script invoked with no base ref, and exit 2.
 *
 * The single-argument gates' case. `check-claim-scope.mjs` calls `declineMissingArgument`
 * directly, because its synopsis has to name the claim as well.
 *
 * @param {string} script - the script's filename, e.g. `check-version-bump.mjs`.
 * @param {string} example - a concrete base ref for the worked invocation, e.g. `origin/main`.
 * @returns {never}
 */
export function declineMissingBaseRef(script, example) {
  declineMissingArgument(script, "<base-ref>", "<base-ref>", example, BASE_REF_NOTE);
}

/**
 * Print the declined-invocation message for a gate given a claim it does not know, and exit 2.
 *
 * Distinct from a missing claim on purpose: "you named a claim this gate does not know" and "you
 * named no claim at all" are different mistakes, and one message covering both by printing a
 * synopsis makes the reader work out which one they made.
 *
 * The received value is echoed because it is a command line the operator typed, not adopter data
 * — §19.2's value-free rule is about validation errors carrying a payload into a log, and a
 * message that will not say which word it rejected cannot be acted on.
 *
 * @param {string} script - the script's filename, e.g. `check-claim-scope.mjs`.
 * @param {string} claim - the unrecognised claim, as given.
 * @param {string} usage - the gate's full argument synopsis.
 * @param {string} example - the arguments of a worked invocation, e.g. `origin/main docs-only`.
 * @param {string} notes - what the arguments mean; one or more lines, no trailing newline.
 * @returns {never}
 */
export function declineUnknownClaim(script, claim, usage, example, notes) {
  decline(
    script,
    `${script} does not know the claim "${claim}", so no gate ran.`,
    usage,
    example,
    `${notes}\nAn unrecognised claim is declined rather than failed: the gate has no opinion ` +
      "about a claim it cannot evaluate.",
  );
}

export { BASE_REF_NOTE };
