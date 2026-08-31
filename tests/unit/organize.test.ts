import { describe, expect, it } from "vitest";
import {
  describeDestroyOutcome,
  describeUpdateOutcome,
  MAX_IDS_PER_CALL,
  refuseOversizedBatch,
  resolveMailboxes,
} from "../../src/domains/mail/organize.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const partial = loadFixture<SetResponse<Email>>("email-set-updated.json");

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m-${index}`);
}

describe("batch ceiling", () => {
  it("lets a batch at the ceiling through", () => {
    expect(refuseOversizedBatch(ids(MAX_IDS_PER_CALL))).toBeUndefined();
  });

  it("refuses one id past the ceiling and says how to split the list", () => {
    const refusal = refuseOversizedBatch(ids(MAX_IDS_PER_CALL + 1));

    expect(refusal).toContain("51");
    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
  });

  it("refuses an empty list and points at the search that produces ids", () => {
    expect(refuseOversizedBatch([])).toContain("mail_search");
  });
});

describe("folder resolution", () => {
  it("asks for the properties an outcome names, and nothing more", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    await resolveMailboxes(context);

    expect(requests[0]?.methodCalls[0]?.[1].properties).toEqual([
      "id",
      "name",
      "parentId",
      "role",
      "totalEmails",
    ]);
  });

  it("reads the folders once however many hooks ask for them", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const [first, second] = await Promise.all([
      resolveMailboxes(context),
      resolveMailboxes(context),
    ]);

    expect(requests).toHaveLength(1);
    expect(second).toBe(first);
  });
});

describe("batch outcome", () => {
  it("claims a plain success only when the server refused nothing", () => {
    const text = describeUpdateOutcome(
      { accountId: "acc-1", oldState: "1", newState: "2", updated: { "m-1": null } },
      ["m-1"],
      "moved to Archive",
    );

    expect(text).toContain("1 message moved to Archive.");
  });

  it("reports a half-refused batch as a part, id by id", () => {
    const text = describeUpdateOutcome(partial, ["m-1", "m-2", "m-3"], "moved to Archive");

    expect(text).toContain("2 of 3 messages moved to Archive, 1 refused");
    expect(text).toMatch(/m-3\s+refused: notFound/);
    expect(text).toMatch(/m-1\s+moved to Archive/);
  });

  it("announces no success at all when the server refused every id", () => {
    const text = describeUpdateOutcome(
      {
        accountId: "acc-1",
        oldState: "1",
        newState: "2",
        notUpdated: {
          "m-1": { type: "forbidden" },
          "m-2": { type: "forbidden" },
        },
      },
      ["m-1", "m-2"],
      "moved to Archive",
    );

    expect(text).toContain("No message was moved to Archive");
    expect(text).not.toMatch(/^2 messages/m);
  });

  it("accounts for a destroy off notDestroyed rather than notUpdated", () => {
    const text = describeDestroyOutcome(
      {
        accountId: "acc-1",
        oldState: "1",
        newState: "2",
        destroyed: ["m-1"],
        notDestroyed: { "m-2": { type: "notFound" } },
      },
      ["m-1", "m-2"],
    );

    expect(text).toContain("1 of 2 messages destroyed");
    expect(text).toMatch(/m-2\s+refused: notFound/);
  });
});
