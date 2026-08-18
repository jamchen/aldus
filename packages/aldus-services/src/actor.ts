/**
 * Actor identity for mutating operations.
 *
 * Contract §19.2: "Mutating actions MUST record actor identity." Contract §3.6 goes further —
 * a human decision only counts once it is "translated into a recorded decision tied to exact
 * inputs", and a decision recorded against nobody is indistinguishable from one nobody made.
 *
 * So the services refuse an anonymous mutation rather than attributing it to a placeholder. The
 * adapter supplies the actor: a CLI flag, an environment variable, a config file, or — for the
 * Production MCP (§18.1) — an authenticated caller. This module only validates what it is given;
 * *where* it came from is the adapter's business, which is what keeps the services usable by both.
 *
 * Read-only operations need no actor. Requiring one for `status` would push every adapter into
 * configuring identity before it could show anything, and §24's promise is that an operator can
 * see the current state without ceremony.
 */

import { validate, type ActorRef } from "@aldus/core";

import { ServiceErrorCodes, serviceError } from "./errors.js";

/**
 * Validate an actor for a mutating operation.
 *
 * @throws {AldusError} `ALDUS_ACTOR_REQUIRED` when none was supplied (§19.2).
 * @throws {AldusError} `ALDUS_ACTOR_INVALID` when the supplied value is not a valid `ActorRef`.
 */
export function requireActor(actor: ActorRef | undefined, operation: string): ActorRef {
  if (actor === undefined) {
    throw serviceError(
      ServiceErrorCodes.ACTOR_REQUIRED,
      `"${operation}" changes durable state, so it requires a recorded actor. Architecture ` +
        "contract §19.2 requires mutating actions to record actor identity, and §3.6 treats an " +
        "unattributed decision as no decision at all.",
      { category: "policy", details: { operation } },
    );
  }

  const result = validate("ActorRef", actor);
  if (!result.ok) {
    throw serviceError(
      ServiceErrorCodes.ACTOR_INVALID,
      `The actor supplied for "${operation}" is not a valid ActorRef.`,
      { category: "validation", details: { operation, issues: result.error.details } },
    );
  }
  return result.value;
}

/**
 * Parse an actor from a `kind:id` string, the form an adapter can accept on a command line or
 * in an environment variable.
 *
 * `id` may itself contain colons — a canonical identity is colon-separated (§6.1) — so only the
 * first separator is significant.
 *
 * @throws {AldusError} `ALDUS_ACTOR_INVALID` if the string is not `kind:id` with a known kind.
 */
export function parseActor(value: string, displayName?: string): ActorRef {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw serviceError(
      ServiceErrorCodes.ACTOR_INVALID,
      `Actor "${value}" is not in "kind:id" form, e.g. "human:operator-a".`,
      { category: "validation", details: { received: value } },
    );
  }

  const candidate = {
    kind: value.slice(0, separator),
    id: value.slice(separator + 1),
    ...(displayName !== undefined ? { displayName } : {}),
  };

  const result = validate("ActorRef", candidate);
  if (!result.ok) {
    throw serviceError(
      ServiceErrorCodes.ACTOR_INVALID,
      `Actor "${value}" does not name a valid actor kind. Expected one of: human, agent, ` +
        "worker, system.",
      { category: "validation", details: { received: value, issues: result.error.details } },
    );
  }
  return result.value;
}
