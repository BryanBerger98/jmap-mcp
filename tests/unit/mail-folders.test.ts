import { describe, expect, it } from "vitest";
import { mailFolders } from "../../src/domains/mail/folders.js";
import type { GetResponse } from "../../src/jmap/types/core.js";
import type { Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");

function rowsOf(text: string): string[] {
  // Drop the header and its underline; what is left is one folder per line.
  return text.split("\n").slice(2);
}

describe("mail_folders", () => {
  it("asks for every mailbox and names the properties it renders", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    await mailFolders.run({}, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls[0]).toMatchObject([
      "Mailbox/get",
      { accountId: "acc-1", ids: null },
      "0",
    ]);
    expect(requests[0]?.methodCalls[0]?.[1].properties).toContain("unreadEmails");
  });

  it("rebuilds the full path of a nested folder", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const { text } = await mailFolders.run({}, context);

    expect(text).toContain("Archive/Newsletters/2024");
  });

  it("orders folders by path so a child follows its parent", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const { text } = await mailFolders.run({}, context);

    const paths = rowsOf(text).map((row) => row.split(/\s{2,}/)[0]);
    expect(paths).toEqual([
      "Archive",
      "Archive/Newsletters",
      "Archive/Newsletters/2024",
      "Detached",
      "Inbox",
    ]);
  });

  it("lists a folder whose parent is gone under its bare name", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const { text } = await mailFolders.run({}, context);

    expect(text).toContain("Detached");
    expect(text).not.toContain("mb-vanished");
  });

  it("carries the role and the unread count", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const { text } = await mailFolders.run({}, context);
    const inbox = rowsOf(text).find((row) => row.startsWith("Inbox"));

    expect(inbox).toContain("inbox");
    expect(inbox).toContain("7");
    expect(inbox).toContain("mb-inbox");
  });

  it("drops empty folders when asked to", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const { text } = await mailFolders.run({ includeEmpty: false }, context);

    expect(text).not.toContain("Archive/Newsletters/2024");
    expect(text).toContain("Archive/Newsletters");
  });
});
