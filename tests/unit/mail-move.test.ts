import { describe, expect, it } from "vitest";
import { mailMove } from "../../src/domains/mail/move.js";
import { MAX_IDS_PER_CALL } from "../../src/domains/mail/organize.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const partial = loadFixture<SetResponse<Email>>("email-set-updated.json");

const CLEAN: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-1",
  newState: "email-state-2",
  updated: { "m-1": null, "m-2": null },
};

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m-${index}`);
}

describe("mail_move", () => {
  it("rewrites mailboxIds whole, so the message leaves every folder it was in", async () => {
    const { context, requests } = fakeTransport([mailboxGet, CLEAN]);

    await mailMove.run({ ids: ["m-1", "m-2"], mailboxId: "mb-archive" }, context);

    const call = requests.at(-1)?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({
      accountId: "acc-1",
      update: {
        "m-1": { mailboxIds: { "mb-archive": true } },
        "m-2": { mailboxIds: { "mb-archive": true } },
      },
    });

    // A `mailboxIds/<id>` path would add the folder and keep the old ones: a copy.
    expect(JSON.stringify(call?.[1])).not.toContain("mailboxIds/");
  });

  it("names the destination folder in what it renders", async () => {
    const { context } = fakeTransport([mailboxGet, CLEAN]);

    const { text } = await mailMove.run({ ids: ["m-1", "m-2"], mailboxId: "mb-archive" }, context);

    expect(text).toContain("2 messages moved to Archive.");
  });

  it("renders a half-refused batch id by id, without claiming a global success", async () => {
    const { context } = fakeTransport([mailboxGet, partial]);

    const { text } = await mailMove.run(
      { ids: ["m-1", "m-2", "m-3"], mailboxId: "mb-archive" },
      context,
    );

    expect(text).toContain("2 of 3 messages moved to Archive, 1 refused");
    expect(text).toMatch(/m-3\s+refused: notFound/);
  });

  it("refuses a folder the account does not hold, without writing anything", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailMove.precheck?.({ ids: ["m-1"], mailboxId: "mb-nope" }, context);

    expect(refusal).toContain("mb-nope");
    expect(refusal).toContain("mail_folders");
    expect(requests.flatMap((request) => request.methodCalls.map((call) => call[0]))).toEqual([
      "Mailbox/get",
    ]);
  });

  it("refuses a batch past the ceiling before it even looks at the folder", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailMove.precheck?.(
      { ids: ids(MAX_IDS_PER_CALL + 1), mailboxId: "mb-archive" },
      context,
    );

    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(requests).toHaveLength(0);
  });

  it("refuses an empty list without emitting a single JMAP method", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailMove.precheck?.({ ids: [], mailboxId: "mb-archive" }, context);

    expect(refusal).toContain("nothing to act on");
    expect(requests).toHaveLength(0);
  });

  it("asks past the configured threshold, citing the count and the folder", async () => {
    const { context } = fakeTransport([mailboxGet], undefined, 2);

    const reason = await mailMove.confirmWhen?.(
      { ids: ["m-1", "m-2", "m-3"], mailboxId: "mb-archive" },
      context,
    );

    expect(reason).toContain("3 messages");
    expect(reason).toContain("Archive");
  });

  it("says nothing at the threshold, so an everyday move runs straight away", async () => {
    const { context, requests } = fakeTransport([mailboxGet], undefined, 2);

    const reason = await mailMove.confirmWhen?.(
      { ids: ["m-1", "m-2"], mailboxId: "mb-archive" },
      context,
    );

    expect(reason).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("stays a draft operation however many messages it carries", () => {
    expect(mailMove.classify({ ids: ids(MAX_IDS_PER_CALL), mailboxId: "mb-archive" })).toBe(
      "draft",
    );
    expect(mailMove.classes).toEqual(["draft"]);
  });
});
