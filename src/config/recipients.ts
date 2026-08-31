/**
 * The recipient perimeter: who this server is allowed to write to.
 *
 * The decision is a pure function of a resolved perimeter and a list of
 * addresses. Nothing here reads the network or the session, so the rule that
 * stops a message from leaving the account can be tested without a server.
 *
 * There is no argument, no environment variable and no tool input that lets a
 * caller step around it: the perimeter is resolved once, at startup, and the
 * check either passes or refuses.
 */

/** The perimeter once resolved, in the four states a startup can produce. */
export type RecipientScope =
  /** No restriction was asked for: every address passes. */
  | { kind: "anyone" }
  /** Address books read, and at least one address came back. */
  | { kind: "restricted"; addresses: ReadonlySet<string>; domains: ReadonlySet<string> }
  /** Restriction asked for, resolved, and nothing at all is inside it. */
  | { kind: "empty" }
  /**
   * The perimeter could not be established. An error never widens it: a scope
   * that failed to resolve refuses everything, exactly as an empty one does.
   */
  | { kind: "unreadable"; reason: string };

export type RecipientCheck = { ok: true } | { ok: false; refusal: string };

/** Open, and the default: nobody pays for a restriction they did not ask for. */
export const OPEN_SCOPE: RecipientScope = { kind: "anyone" };

/**
 * Decides whether every one of these addresses may be written to.
 *
 * Addresses are compared folded to lower case and stripped of any display name.
 * The local part is case-sensitive per RFC 5321, so folding is a deliberate
 * leniency: a perimeter is a list a human typed, and refusing `Camille@` when
 * they wrote `camille@` would read as a bug rather than as a protection.
 */
export function checkRecipients(
  addresses: readonly string[],
  scope: RecipientScope,
): RecipientCheck {
  if (scope.kind === "anyone") return { ok: true };

  if (scope.kind === "unreadable") {
    return {
      ok: false,
      refusal:
        "Refused: this server is restricted to the addresses in your address books, and they " +
        `could not be read (${scope.reason}). Nothing is sent while the perimeter is unknown.`,
    };
  }

  if (scope.kind === "empty") {
    return {
      ok: false,
      refusal:
        "Refused: this server is restricted to the addresses in your address books, and the " +
        "perimeter is empty — no contact card and no allowed address. There is nobody it may " +
        "write to.",
    };
  }

  const rejected = addresses.find((address) => !isWithinScope(address, scope));
  if (rejected === undefined) return { ok: true };

  return {
    ok: false,
    refusal:
      `Refused: ${rejected} is outside the recipient perimeter this server is configured with. ` +
      "Only addresses held in your address books, or listed in the allow setting, can be written " +
      "to. Add the address to a contact card, or to that list.",
  };
}

/**
 * Whether one address is inside the perimeter, in every one of its four states.
 *
 * Exported because showing that an address is refused and refusing it have to
 * be the one rule: a comparison copied out for display would drift, one day,
 * from the refusal it claims to explain. `checkRecipients` is written over it,
 * and nothing else decides membership.
 */
export function isWithinScope(address: string, scope: RecipientScope): boolean {
  switch (scope.kind) {
    case "anyone":
      return true;
    case "restricted":
      return isListed(address, scope);
    // A perimeter that is empty, or that failed to resolve, holds nobody. An
    // error never widens it, so both refuse exactly as the other does.
    case "empty":
    case "unreadable":
      return false;
  }
}

function isListed(
  address: string,
  scope: { addresses: ReadonlySet<string>; domains: ReadonlySet<string> },
): boolean {
  const folded = address.trim().toLowerCase();
  if (scope.addresses.has(folded)) return true;

  const domain = folded.slice(folded.lastIndexOf("@") + 1);
  return domain !== "" && scope.domains.has(domain);
}

/**
 * Splits the configured allow list into the two things it holds.
 *
 * An entry starting with `@` is a whole domain; anything else is one address.
 * The schema has already refused every other shape.
 */
export function partitionAllowList(allow: readonly string[]): {
  addresses: string[];
  domains: string[];
} {
  const addresses: string[] = [];
  const domains: string[] = [];

  for (const entry of allow) {
    const folded = entry.trim().toLowerCase();
    if (folded.startsWith("@")) domains.push(folded.slice(1));
    else addresses.push(folded);
  }

  return { addresses, domains };
}

/**
 * Builds a restricted perimeter, or reports it empty.
 *
 * The two sources are unioned rather than ranked: an address a contact card
 * carries and an address the operator typed are equally inside.
 */
export function restrictTo(input: {
  fromContacts: readonly string[];
  allow: readonly string[];
}): RecipientScope {
  const listed = partitionAllowList(input.allow);
  const addresses = new Set(
    [...input.fromContacts, ...listed.addresses].map((address) => address.trim().toLowerCase()),
  );
  const domains = new Set(listed.domains);

  if (addresses.size === 0 && domains.size === 0) return { kind: "empty" };
  return { kind: "restricted", addresses, domains };
}

/**
 * The one line the client is told at initialization, or nothing when the
 * perimeter is open. A restriction the assistant learns by being refused is a
 * restriction it discovers too late.
 */
export function describeScope(scope: RecipientScope): string | undefined {
  switch (scope.kind) {
    case "anyone":
      return undefined;
    case "restricted":
      return (
        `Outbound messages are restricted to ${scope.addresses.size} address(es) held in this ` +
        `account's address books${scope.domains.size > 0 ? ` and ${scope.domains.size} allowed domain(s)` : ""}. ` +
        "Any other recipient is refused before anything is written."
      );
    case "empty":
      return (
        "Outbound messages are restricted to this account's address books, and that perimeter is " +
        "currently empty: no message can be sent to anyone until a contact card exists."
      );
    case "unreadable":
      return (
        "Outbound messages are restricted to this account's address books, which could not be " +
        `read (${scope.reason}). Every send is refused until they can be.`
      );
  }
}
