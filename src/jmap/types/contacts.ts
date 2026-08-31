/**
 * JMAP for Contacts (draft) — the read-only slice the recipient perimeter needs.
 *
 * Only what resolving that perimeter asks for is declared. The contacts domain
 * will widen this file when it lands; until then a property nobody requests
 * would be typed as present on a response that never carries it.
 */

import type { Id } from "./core.js";

/**
 * One email address on a card.
 *
 * `address` is the only property JSContact makes mandatory, which is why the
 * perimeter reads it and nothing else: contexts and preference say where a
 * person prefers to be reached, not whether they may be written to.
 */
export interface EmailAddressEntry {
  address: string;
  contexts?: Record<string, boolean>;
  pref?: number;
}

/**
 * A contact card, as JSContact defines it.
 *
 * `emails` is a map keyed by an opaque id rather than a list: the keys carry no
 * meaning here, only the values do.
 */
export interface ContactCard {
  id: Id;
  emails?: Record<string, EmailAddressEntry>;
}

export type ContactCardQueryArguments = {
  accountId: Id;
  filter?: Record<string, unknown>;
  /** Stalwart sorts cards on `created` and `updated` only; anything else fails. */
  sort?: { property: string; isAscending: boolean }[];
  position?: number;
  limit?: number;
};

export type ContactCardGetArguments = {
  accountId: Id;
  ids?: Id[] | null;
  properties?: string[] | null;
};
