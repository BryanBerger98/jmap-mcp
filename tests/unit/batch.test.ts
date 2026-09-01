import { describe, expect, it } from "vitest";
import { MAX_IDS_PER_CALL, refuseOversizedBatch } from "../../src/shared/batch.js";

/** What a domain hands over, as the contacts tools will name it. */
const CARDS = { noun: "contact card", discoveredBy: "contacts_search" };

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `id-${index}`);
}

describe("refuseOversizedBatch", () => {
  it("lets a batch within the ceiling through", () => {
    expect(refuseOversizedBatch(ids(MAX_IDS_PER_CALL), CARDS)).toBeUndefined();
  });

  it("refuses one id past the ceiling, naming the ceiling itself", () => {
    const refusal = refuseOversizedBatch(ids(MAX_IDS_PER_CALL + 1), CARDS);

    expect(refusal).toContain(String(MAX_IDS_PER_CALL + 1));
    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
  });

  it("refuses an empty list rather than sending a call that acts on nothing", () => {
    const refusal = refuseOversizedBatch([], CARDS);

    expect(refusal).toBeDefined();
    expect(refusal).toContain("nothing to act on");
  });

  it("names the domain's own object and the tool that hands its ids out", () => {
    const empty = refuseOversizedBatch([], CARDS);
    const oversized = refuseOversizedBatch(ids(MAX_IDS_PER_CALL + 1), CARDS);

    expect(empty).toContain("contact card");
    expect(empty).toContain("contacts_search");
    expect(oversized).toContain("contact card");
  });

  it("keeps the mail wording it was hoisted out of, to the word", () => {
    const refusal = refuseOversizedBatch(ids(51), {
      noun: "message",
      discoveredBy: "mail_search",
    });

    expect(refusal).toBe(
      "Refused: 51 message ids were given, and this server acts on at most 50 per call. " +
        "Split the list into batches of 50 or fewer and call once per batch, so each batch is " +
        "accounted for on its own.",
    );
  });
});
