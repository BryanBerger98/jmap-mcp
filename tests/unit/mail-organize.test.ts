import { describe, expect, it } from "vitest";
import { MAX_IDS_PER_CALL } from "../../src/domains/mail/filing.js";
import { mailOrganize } from "../../src/domains/mail/organize.js";
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

describe("mail_organize, moving", () => {
  it("rewrites mailboxIds whole, so the message leaves every folder it was in", async () => {
    const { context, requests } = fakeTransport([mailboxGet, CLEAN]);

    await mailOrganize.run(
      { action: "move", ids: ["m-1", "m-2"], mailboxId: "mb-archive" },
      context,
    );

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

    const { text } = await mailOrganize.run(
      { action: "move", ids: ["m-1", "m-2"], mailboxId: "mb-archive" },
      context,
    );

    expect(text).toContain("2 messages moved to Archive.");
  });

  it("renders a half-refused batch id by id, without claiming a global success", async () => {
    const { context } = fakeTransport([mailboxGet, partial]);

    const { text } = await mailOrganize.run(
      { action: "move", ids: ["m-1", "m-2", "m-3"], mailboxId: "mb-archive" },
      context,
    );

    expect(text).toContain("2 of 3 messages moved to Archive, 1 refused");
    expect(text).toMatch(/m-3\s+refused: notFound/);
  });

  it("refuses a folder the account does not hold, without writing anything", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailOrganize.precheck?.(
      { action: "move", ids: ["m-1"], mailboxId: "mb-nope" },
      context,
    );

    expect(refusal).toContain("mb-nope");
    expect(refusal).toContain("mail_folders");
    expect(requests.flatMap((request) => request.methodCalls.map((call) => call[0]))).toEqual([
      "Mailbox/get",
    ]);
  });

  it("refuses a batch past the ceiling before it even looks at the folder", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailOrganize.precheck?.(
      { action: "move", ids: ids(MAX_IDS_PER_CALL + 1), mailboxId: "mb-archive" },
      context,
    );

    expect(refusal).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(requests).toHaveLength(0);
  });

  it("refuses an empty list without emitting a single JMAP method", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailOrganize.precheck?.(
      { action: "move", ids: [], mailboxId: "mb-archive" },
      context,
    );

    expect(refusal).toContain("nothing to act on");
    expect(requests).toHaveLength(0);
  });

  it("asks past the configured threshold, citing the count and the folder", async () => {
    const { context } = fakeTransport([mailboxGet], { bulkConfirmAbove: 2 });

    const reason = await mailOrganize.confirmWhen?.(
      { action: "move", ids: ["m-1", "m-2", "m-3"], mailboxId: "mb-archive" },
      context,
    );

    expect(reason).toContain("3 messages");
    expect(reason).toContain("Archive");
  });

  it("says nothing at the threshold, so an everyday move runs straight away", async () => {
    const { context, requests } = fakeTransport([mailboxGet], { bulkConfirmAbove: 2 });

    const reason = await mailOrganize.confirmWhen?.(
      { action: "move", ids: ["m-1", "m-2"], mailboxId: "mb-archive" },
      context,
    );

    expect(reason).toBeUndefined();
    expect(requests).toHaveLength(0);
  });

  it("refuses a move that names no destination folder", () => {
    const parsed = mailOrganize.inputSchema.safeParse({ action: "move", ids: ["m-1"] });
    expect(parsed.success).toBe(false);
  });
});

describe("mail_organize, marking", () => {
  it("patches one keyword path and leaves every other property alone", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailOrganize.run({ action: "flag", ids: ["m-1", "m-2"], add: ["seen"] }, context);

    const call = requests[0]?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({
      update: { "m-1": { "keywords/$seen": true }, "m-2": { "keywords/$seen": true } },
    });
    // Neither the whole keyword map nor the folders: marking moves nothing.
    const update = (call?.[1].update ?? {}) as Record<string, object>;
    expect(Object.keys(update["m-1"] ?? {})).toEqual(["keywords/$seen"]);
  });

  it("clears a keyword with null rather than false, as RFC 8620 patches do", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailOrganize.run({ action: "flag", ids: ["m-1"], remove: ["flagged"] }, context);

    const update = requests[0]?.methodCalls[0]?.[1].update as Record<string, object>;
    expect(update["m-1"]).toEqual({ "keywords/$flagged": null });
  });

  it("carries an add and a remove in the same patch", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    await mailOrganize.run(
      { action: "flag", ids: ["m-1"], add: ["seen"], remove: ["flagged"] },
      context,
    );

    const update = requests[0]?.methodCalls[0]?.[1].update as Record<string, object>;
    expect(update["m-1"]).toEqual({ "keywords/$seen": true, "keywords/$flagged": null });
  });

  it("says which keywords it wrote, id by id", async () => {
    const { context } = fakeTransport([partial]);

    const { text } = await mailOrganize.run(
      { action: "flag", ids: ["m-1", "m-2", "m-3"], add: ["seen"], remove: ["flagged"] },
      context,
    );

    expect(text).toContain("marked $seen, cleared $flagged");
    expect(text).toMatch(/m-3\s+refused: notFound/);
  });

  it("never asks, however many messages the marking covers", async () => {
    const { context } = fakeTransport([CLEAN], { bulkConfirmAbove: 2 });

    expect(
      await mailOrganize.confirmWhen?.({ action: "flag", ids: ids(50), add: ["seen"] }, context),
    ).toBeUndefined();
    expect(
      await mailOrganize.precheck?.({ action: "flag", ids: ids(100), add: ["seen"] }, context),
    ).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(
      await mailOrganize.precheck?.({ action: "flag", ids: ids(50), add: ["seen"] }, context),
    ).toBeUndefined();
  });

  it("refuses an empty list without emitting a single JMAP method", async () => {
    const { context, requests } = fakeTransport([CLEAN]);

    expect(
      await mailOrganize.precheck?.({ action: "flag", ids: [], add: ["seen"] }, context),
    ).toContain("nothing to act on");
    expect(requests).toHaveLength(0);
  });

  it("takes no keyword outside the standard set, and never $draft", () => {
    const parsed = mailOrganize.inputSchema.safeParse({
      action: "flag",
      ids: ["m-1"],
      add: ["draft"],
    });
    expect(parsed.success).toBe(false);

    const invented = mailOrganize.inputSchema.safeParse({
      action: "flag",
      ids: ["m-1"],
      add: ["urgent"],
    });
    expect(invented.success).toBe(false);
  });

  it("refuses a call that names no keyword at all", () => {
    expect(mailOrganize.inputSchema.safeParse({ action: "flag", ids: ["m-1"] }).success).toBe(
      false,
    );
    expect(
      mailOrganize.inputSchema.safeParse({ action: "flag", ids: ["m-1"], add: [], remove: [] })
        .success,
    ).toBe(false);
    expect(
      mailOrganize.inputSchema.safeParse({ action: "flag", ids: ["m-1"], add: ["seen"] }).success,
    ).toBe(true);
  });
});

describe("mail_organize, what the two actions share and where they part", () => {
  it("stays a draft operation whichever action it carries, however many messages", () => {
    expect(
      mailOrganize.classify({
        action: "move",
        ids: ids(MAX_IDS_PER_CALL),
        mailboxId: "mb-archive",
      }),
    ).toBe("draft");
    expect(
      mailOrganize.classify({ action: "flag", ids: ids(MAX_IDS_PER_CALL), add: ["seen"] }),
    ).toBe("draft");
    expect(mailOrganize.classes).toEqual(["draft"]);
  });

  it("asks on the same volume when it moves and stays quiet when it marks", async () => {
    const { context } = fakeTransport([mailboxGet], { bulkConfirmAbove: 2 });
    const batch = ["m-1", "m-2", "m-3"];

    const onMove = await mailOrganize.confirmWhen?.(
      { action: "move", ids: batch, mailboxId: "mb-archive" },
      context,
    );
    const onFlag = await mailOrganize.confirmWhen?.(
      { action: "flag", ids: batch, add: ["seen"] },
      context,
    );

    // The whole point of the merge: the volume is identical, and the answer is
    // not. A marking is undone by the opposite marking; a move at scale leaves
    // no record of the folders it emptied.
    expect(onMove).toContain("3 messages");
    expect(onFlag).toBeUndefined();
  });
});
