import { describe, expect, it } from "vitest";
import { mailDelete } from "../../src/domains/mail/delete.js";
import { MAX_IDS_PER_CALL } from "../../src/domains/mail/organize.js";
import type { GetResponse, SetResponse } from "../../src/jmap/types/core.js";
import type { Email, Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const subjects = loadFixture<GetResponse<Email>>("email-get-subjects.json");
const destroyed = loadFixture<SetResponse<Email>>("email-set-destroyed.json");

/** The same account with its trash folder taken away. */
const noTrash: GetResponse<Mailbox> = {
  ...mailboxGet,
  list: mailboxGet.list.filter((mailbox) => mailbox.role !== "trash"),
};

const CLEAN: SetResponse<Email> = {
  accountId: "acc-1",
  oldState: "email-state-1",
  newState: "email-state-2",
  updated: { "m-1": null, "m-2": null },
};

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `m-${index}`);
}

describe("mail_delete, the reversible way", () => {
  it("files the messages into the trash folder and nowhere else", async () => {
    const { context, requests } = fakeTransport([mailboxGet, CLEAN]);

    await mailDelete.run({ ids: ["m-1", "m-2"] }, context);

    const call = requests.at(-1)?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({
      update: {
        "m-1": { mailboxIds: { "mb-trash": true } },
        "m-2": { mailboxIds: { "mb-trash": true } },
      },
    });
    expect(call?.[1].destroy).toBeUndefined();
  });

  it("finds the trash by its role, never by its name", async () => {
    // The folder is named "Trash" in the fixture; only the role is looked at.
    const renamed: GetResponse<Mailbox> = {
      ...mailboxGet,
      list: mailboxGet.list.map((mailbox) =>
        mailbox.role === "trash" ? { ...mailbox, name: "Corbeille" } : mailbox,
      ),
    };
    const { context } = fakeTransport([renamed, CLEAN]);

    const { text } = await mailDelete.run({ ids: ["m-1", "m-2"] }, context);

    expect(text).toContain("moved to Corbeille");
  });

  it("refuses an account with no trash folder, creating nothing", async () => {
    const { context, requests } = fakeTransport([noTrash]);

    const refusal = await mailDelete.precheck?.({ ids: ["m-1"] }, context);

    expect(refusal).toContain("`trash` role");
    expect(refusal).toContain("permanent");
    expect(requests.flatMap((request) => request.methodCalls.map((call) => call[0]))).toEqual([
      "Mailbox/get",
    ]);
  });

  it("asks past the threshold, naming the trash and not destruction", async () => {
    const { context } = fakeTransport([mailboxGet], undefined, 2);

    const reason = await mailDelete.confirmWhen?.({ ids: ["m-1", "m-2", "m-3"] }, context);

    expect(reason).toContain("trash");
    expect(reason).not.toContain("destroy");
  });
});

describe("mail_delete, the permanent way", () => {
  it("destroys the ids as they came, and updates nothing", async () => {
    const { context, requests } = fakeTransport([destroyed]);

    await mailDelete.run({ ids: ["m-1", "m-2", "m-3"], permanent: true }, context);

    const call = requests[0]?.methodCalls[0];
    expect(call?.[0]).toBe("Email/set");
    expect(call?.[1]).toMatchObject({ destroy: ["m-1", "m-2", "m-3"] });
    expect(call?.[1].update).toBeUndefined();

    // One request: destroying never follows a move to the trash.
    expect(requests).toHaveLength(1);
  });

  it("renders a half-refused destruction id by id", async () => {
    const { context } = fakeTransport([destroyed]);

    const { text } = await mailDelete.run({ ids: ["m-1", "m-2", "m-3"], permanent: true }, context);

    expect(text).toContain("2 of 3 messages destroyed");
    expect(text).toMatch(/m-3\s+refused: notFound/);
  });

  it("needs no trash folder of its own", async () => {
    const { context } = fakeTransport([noTrash]);

    expect(await mailDelete.precheck?.({ ids: ["m-1"], permanent: true }, context)).toBeUndefined();
  });

  it("never escalates on volume: its class already asks", async () => {
    const { context } = fakeTransport([mailboxGet], undefined, 2);

    expect(
      await mailDelete.confirmWhen?.({ ids: ids(10), permanent: true }, context),
    ).toBeUndefined();
  });
});

describe("what mail_delete says before it runs", () => {
  it("names the messages by subject, not by count alone", async () => {
    const { context } = fakeTransport([subjects]);

    const summary = await mailDelete.summarize(
      { ids: ["m-1", "m-2", "m-3"], permanent: true },
      context,
    );

    expect(summary).toContain("3 messages");
    expect(summary).toContain("Facture de janvier");
    expect(summary).toContain("(no subject)");
    expect(summary).toContain("Nothing recovers them");
  });

  it("asks for the subject and nothing slower", async () => {
    const { context, requests } = fakeTransport([subjects]);

    await mailDelete.summarize({ ids: ["m-1"] }, context);

    expect(requests[0]?.methodCalls[0]?.[1].properties).toEqual(["id", "subject"]);
  });

  it("falls back on the bare count when the subjects cannot be read", async () => {
    // An empty queue answers `{}`, which has no `list`: the read fails.
    const { context } = fakeTransport([]);

    const summary = await mailDelete.summarize({ ids: ["m-1", "m-2"], permanent: true }, context);

    expect(summary).toContain("2 messages");
    expect(summary).not.toContain("Refused");
  });

  it("classifies on permanent alone", () => {
    expect(mailDelete.classify({ ids: ["m-1"] })).toBe("draft");
    expect(mailDelete.classify({ ids: ["m-1"], permanent: false })).toBe("draft");
    expect(mailDelete.classify({ ids: ["m-1"], permanent: true })).toBe("destroy");
    expect(mailDelete.classes).toEqual(["draft", "destroy"]);
  });

  it("refuses a batch past the ceiling on either branch", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    for (const permanent of [false, true]) {
      expect(
        await mailDelete.precheck?.({ ids: ids(MAX_IDS_PER_CALL + 1), permanent }, context),
      ).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    }

    expect(requests).toHaveLength(0);
  });
});
