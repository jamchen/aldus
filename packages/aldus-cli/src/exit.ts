/**
 * Exit codes (architecture contract §18).
 *
 * §18 requires machine-readable output, and an exit code is the most machine-readable output
 * there is: it is what a shell script branches on before it ever parses stdout. So the codes have
 * to answer the question a script actually asks, which is not "did it work" but **"is this my
 * fault, the runtime's fault, or simply not allowed yet?"**
 *
 * Collapsing those into a single non-zero code is the common mistake, and it makes a CLI
 * unscriptable: `aldus approve … || echo "broken"` would report a breakage every time a gate was
 * legitimately not ready. Four codes keep the distinctions an operator has to act on differently.
 */

/** What the process exits with. */
export const ExitCodes = {
  /** The operation completed and its result is what was asked for. */
  success: 0,
  /**
   * The operation is understood and **not permitted right now**.
   *
   * A gate is not satisfied, spend is not authorized, an Episode already exists. Contract §13 and
   * §19.3 make these ordinary answers, not malfunctions — a script may reasonably wait and retry.
   */
  refused: 1,
  /**
   * Something is wrong with the invocation or the environment.
   *
   * A malformed argument, an unknown Run, a missing workspace, an IO failure. Retrying unchanged
   * will not help.
   */
  error: 2,
  /**
   * The operation ran and reached a terminal state that is not success.
   *
   * A stage failed, was cancelled, or halted at a gate. Distinct from `refused` because the work
   * *was* attempted, and distinct from `error` because nothing is broken — a gate halt is the
   * runtime doing exactly what §11 requires. A script chaining stages must stop here, which is
   * why this cannot be 0.
   */
  unsuccessful: 3,
} as const;

/** @see ExitCodes */
export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];
