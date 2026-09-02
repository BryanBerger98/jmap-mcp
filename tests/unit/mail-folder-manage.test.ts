import { describe, expect, it } from "vitest";
import { mailFolderManage } from "../../src/domains/mail/folder-manage.js";
import type { GetResponse, JmapRequest, SetResponse } from "../../src/jmap/types/core.js";
import type { Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

const mailboxGet = loadFixture<GetResponse<Mailbox>>("mailbox-get.json");
const set = loadFixture<Record<string, SetResponse<Mailbox>>>("mailbox-set.json");

/** The same account, with one folder rewritten. */
function patched(id: string, changes: Partial<Mailbox>): GetResponse<Mailbox> {
  return {
    ...mailboxGet,
    list: mailboxGet.list.map((mailbox) =>
      mailbox.id === id ? { ...mailbox, ...changes } : mailbox,
    ),
  };
}

/** The account plus one extra folder, for the cases the fixture has no room for. */
function withFolder(extra: Mailbox): GetResponse<Mailbox> {
  return { ...mailboxGet, list: [...mailboxGet.list, extra] };
}

function emitted(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map((call) => call[0]));
}

describe("mail_folder_manage, the four actions", () => {
  it("creates a folder under the parent it was given", async () => {
    const { context, requests } = fakeTransport([set.created]);

    const { text } = await mailFolderManage.run(
      { action: "create", name: "Invoices", parentId: "mb-archive" },
      context,
    );

    const call = requests[0]?.methodCalls[0];
    expect(call?.[0]).toBe("Mailbox/set");
    expect(call?.[1].create).toEqual({ new: { name: "Invoices", parentId: "mb-archive" } });
    expect(call?.[1].update).toBeUndefined();
    expect(call?.[1].destroy).toBeUndefined();
    expect(text).toContain("mb-invoices");
  });

  it("renames a folder without touching where it sits", async () => {
    const { context, requests } = fakeTransport([set.updated]);

    const { text } = await mailFolderManage.run(
      { action: "rename", mailboxId: "mb-2024", name: "2025" },
      context,
    );

    const update = (requests[0]?.methodCalls[0]?.[1].update ?? {}) as Record<string, object>;
    expect(Object.keys(update["mb-2024"] ?? {})).toEqual(["name"]);
    expect(text).toContain("2025");
  });

  it("moves a folder without touching its name", async () => {
    const { context, requests } = fakeTransport([set.updated]);

    await mailFolderManage.run(
      { action: "move", mailboxId: "mb-2024", parentId: "mb-archive" },
      context,
    );

    const update = (requests[0]?.methodCalls[0]?.[1].update ?? {}) as Record<string, object>;
    expect(update["mb-2024"]).toEqual({ parentId: "mb-archive" });
  });

  it("deletes an empty folder, and says no message went with it", async () => {
    const { context, requests } = fakeTransport([set.destroyed]);

    const { text } = await mailFolderManage.run(
      { action: "delete", mailboxId: "mb-2024" },
      context,
    );

    expect(requests[0]?.methodCalls[0]?.[1]).toMatchObject({
      destroy: ["mb-2024"],
      onDestroyRemoveEmails: false,
    });
    expect(text).toContain("No message was removed");
  });

  it("hands back the mail server's own refusal", async () => {
    const { context } = fakeTransport([set.notDestroyed]);

    const { text } = await mailFolderManage.run(
      { action: "delete", mailboxId: "mb-2024" },
      context,
    );

    expect(text).toContain("mailboxHasEmail");
  });

  it("classifies on the action alone", () => {
    expect(mailFolderManage.classify({ action: "create", name: "x" })).toBe("draft");
    expect(mailFolderManage.classify({ action: "rename", mailboxId: "mb-2024", name: "x" })).toBe(
      "draft",
    );
    expect(mailFolderManage.classify({ action: "move", mailboxId: "mb-2024" })).toBe("draft");
    expect(mailFolderManage.classify({ action: "delete", mailboxId: "mb-2024" })).toBe("destroy");
    expect(mailFolderManage.classes).toEqual(["draft", "destroy"]);
  });

  it("asks for a name where a name is needed, and an id where an id is", () => {
    expect(mailFolderManage.inputSchema.safeParse({ action: "create" }).success).toBe(false);
    expect(mailFolderManage.inputSchema.safeParse({ action: "delete" }).success).toBe(false);
    expect(
      mailFolderManage.inputSchema.safeParse({ action: "rename", mailboxId: "mb-2024" }).success,
    ).toBe(false);
    expect(
      mailFolderManage.inputSchema.safeParse({ action: "move", mailboxId: "mb-2024" }).success,
    ).toBe(true);
  });
});

describe("what mail_folder_manage refuses before it writes", () => {
  it("refuses a folder the account does not have, naming it", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "rename", mailboxId: "mb-nope", name: "x" },
      context,
    );

    expect(refusal).toContain("mb-nope");
    expect(emitted(requests)).toEqual(["Mailbox/get"]);
  });

  it("refuses to rename a folder that carries a role, citing the role", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "rename", mailboxId: "mb-trash", name: "Corbeille" },
      context,
    );

    expect(refusal).toContain("`trash`");
    expect(emitted(requests)).toEqual(["Mailbox/get"]);
  });

  it("refuses to delete a folder that carries a role, citing the role", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "delete", mailboxId: "mb-inbox" },
      context,
    );

    expect(refusal).toContain("`inbox`");
  });

  it("refuses to delete a folder holding messages, citing how many", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "delete", mailboxId: "mb-newsletters" },
      context,
    );

    expect(refusal).toContain("312 messages");
    expect(refusal).toContain("mail_organize");
    expect(emitted(requests)).toEqual(["Mailbox/get"]);
  });

  it("refuses to delete a folder holding another, naming the child", async () => {
    // Emptied of its messages, so the count is not what stops it.
    const { context } = fakeTransport([patched("mb-newsletters", { totalEmails: 0 })]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "delete", mailboxId: "mb-newsletters" },
      context,
    );

    expect(refusal).toContain("2024");
  });

  it("refuses a name already taken under the same parent, naming the clash", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "create", name: "newsletters", parentId: "mb-archive" },
      context,
    );

    expect(refusal).toContain("Newsletters");
    expect(refusal).toContain("mb-newsletters");
  });

  it("lets the same name live under a different parent", async () => {
    const { context } = fakeTransport([mailboxGet]);

    expect(
      await mailFolderManage.precheck?.({ action: "create", name: "Newsletters" }, context),
    ).toBeUndefined();
  });

  it("refuses a rename onto a sibling's name", async () => {
    const sibling: Mailbox = {
      id: "mb-2025",
      name: "2025",
      parentId: "mb-newsletters",
      role: null,
      totalEmails: 0,
    };
    const { context } = fakeTransport([withFolder(sibling)]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "rename", mailboxId: "mb-2024", name: "2025" },
      context,
    );

    expect(refusal).toContain("mb-2025");
  });

  it("lets a folder keep its own name", async () => {
    const { context } = fakeTransport([mailboxGet]);

    expect(
      await mailFolderManage.precheck?.(
        { action: "rename", mailboxId: "mb-2024", name: "2024" },
        context,
      ),
    ).toBeUndefined();
  });

  it("refuses a move under a parent the account does not have", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "move", mailboxId: "mb-2024", parentId: "mb-nope" },
      context,
    );

    expect(refusal).toContain("mb-nope");
  });

  it("refuses a folder as its own parent", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const refusal = await mailFolderManage.precheck?.(
      { action: "move", mailboxId: "mb-2024", parentId: "mb-2024" },
      context,
    );

    expect(refusal).toContain("its own parent");
  });

  it("refuses a move under one of the folder's own descendants", async () => {
    const { context, requests } = fakeTransport([mailboxGet]);

    // mb-2024 sits under mb-newsletters, which sits under mb-archive.
    const refusal = await mailFolderManage.precheck?.(
      { action: "move", mailboxId: "mb-archive", parentId: "mb-2024" },
      context,
    );

    expect(refusal).toContain("folder tree");
    expect(emitted(requests)).toEqual(["Mailbox/get"]);
  });

  it("lets a folder move up to the root", async () => {
    const { context } = fakeTransport([mailboxGet]);

    expect(
      await mailFolderManage.precheck?.(
        { action: "move", mailboxId: "mb-2024", parentId: null },
        context,
      ),
    ).toBeUndefined();
  });
});

describe("what mail_folder_manage says before it runs", () => {
  it("names the folder by name, not by id", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const summary = await mailFolderManage.summarize(
      { action: "delete", mailboxId: "mb-2024" },
      context,
    );

    expect(summary).toContain("2024");
    expect(summary).toContain("does not come back");
  });

  it("names the parent a creation lands under", async () => {
    const { context } = fakeTransport([mailboxGet]);

    const summary = await mailFolderManage.summarize(
      { action: "create", name: "Invoices", parentId: "mb-archive" },
      context,
    );

    expect(summary).toContain("Archive");
  });
});
