/**
 * The declined-invocation message shared by the release gate scripts.
 *
 * A check has three states and `DECLINED` is never folded into either other one — the costliest
 * failure in the #165–#171 series was a non-answer read as an answer. Both release gates already
 * exited 2 for a missing base ref, which is a correct declined signal, and printed a bare
 * `usage:` line, which is not: a reader — an agent especially — cannot tell "the gate ran and did
 * not like what it saw" from "the gate never ran" out of one usage line and a status code they
 * may not have captured.
 *
 * Exit 2 is unchanged. CI and ADR-0050 read these codes, so the fix is entirely in what the
 * message says: that this is a declined invocation, that it is neither a pass nor a failure, what
 * argument is missing, and one invocation that would work.
 *
 * The wording lives here rather than in each script because two scripts stating the same three
 * states in two spellings is how one of them drifts.
 *
 * Found by the independent review of PR #263; same defect class as issue #228.
 */

/**
 * Print the declined-invocation message for a gate script invoked with no base ref, and exit 2.
 *
 * @param {string} script - the script's filename, e.g. `check-version-bump.mjs`.
 * @param {string} example - a concrete base ref for the worked invocation, e.g. `origin/main`.
 * @returns {never}
 */
export function declineMissingBaseRef(script, example) {
  console.error(`DECLINED: ${script} was invoked with no <base-ref> argument, so no gate ran.`);
  console.error("This is a declined invocation. It is NOT a gate pass and NOT a gate failure.\n");
  console.error(`usage: node scripts/${script} <base-ref>`);
  console.error(`  e.g. node scripts/${script} ${example}\n`);
  console.error(
    "<base-ref> is the ref this branch is compared against — normally the merge target.\n" +
      "Exit codes: 0 the gate passed, 1 the gate failed, 2 declined (no result).",
  );
  process.exit(2);
}
