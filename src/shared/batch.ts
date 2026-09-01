/**
 * What a batch of ids may carry, whichever domain hands it over.
 *
 * The ceiling lived in `domains/mail/organize.ts` while mail was the only thing
 * that wrote. A second writing domain means either an import across two domains
 * that know nothing of each other, or a second constant that drifts from the
 * first at the next adjustment; neither is a ceiling anyone can rely on.
 */

import type { Id } from "../jmap/types/core.js";

/**
 * How many object ids one call may carry.
 *
 * Not a configuration key, unlike the confirmation threshold: that one is a
 * personal caution and this one protects the server, which accepts 500 objects
 * per `/set` and would answer a batch of that size with one wall of text. It is
 * also the ceiling on how wrong a single mistaken call can go.
 */
export const MAX_IDS_PER_CALL = 50;

/** What the domain calls the things it hands ids for. */
export interface BatchSubject {
  /**
   * What one id names: "message", "contact card".
   *
   * Read as a qualifier of "id" in both sentences below — "no message id",
   * "51 contact card ids" — so no plural form of it is ever needed here. What
   * needs one is the outcome rendering, which counts objects rather than ids.
   */
  noun: string;
  /** The tool that hands out these ids, named so an empty batch has a way out. */
  discoveredBy: string;
}

/**
 * The refusal an unusable batch raises, or `undefined` to go ahead.
 *
 * Raised from `precheck` rather than from the schema: a contract test calls the
 * handler directly, and a ceiling the schema alone enforced would never be
 * crossed by the very test written to prove it holds.
 */
export function refuseOversizedBatch(
  ids: readonly Id[],
  subject: BatchSubject,
): string | undefined {
  if (ids.length === 0) {
    return (
      `Refused: no ${subject.noun} id was given, so there is nothing to act on. ` +
      `Run ${subject.discoveredBy} first and pass the ids it returns.`
    );
  }

  if (ids.length > MAX_IDS_PER_CALL) {
    return (
      `Refused: ${ids.length} ${subject.noun} ids were given, and this server acts on at most ` +
      `${MAX_IDS_PER_CALL} per call. Split the list into batches of ${MAX_IDS_PER_CALL} or fewer ` +
      "and call once per batch, so each batch is accounted for on its own."
    );
  }

  return undefined;
}
