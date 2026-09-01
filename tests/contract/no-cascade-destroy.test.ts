import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contactsBookManage } from "../../src/domains/contacts/book-manage.js";
import { mailFolderManage } from "../../src/domains/mail/folder-manage.js";
import type { AddressBook } from "../../src/jmap/types/contacts.js";
import type { Invocation, SetResponse } from "../../src/jmap/types/core.js";
import type { Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * Contract: deleting a container never deletes what it holds.
 *
 * Two containers answer to this now — a mail folder and an address book — and
 * the invariant is word for word the same. The flag is one word on the wire,
 * and its absence is not a refusal: the server falls back on a default this
 * project does not own. Every `Mailbox/set` and every `AddressBook/set` this
 * server emits states it, and states it false, so a container write can never
 * become a content loss whatever the server's defaults are.
 */

const set = loadFixture<Record<string, SetResponse<Mailbox>>>("mailbox-set.json");
const bookSet = loadFixture<Record<string, SetResponse<AddressBook>>>("address-book-set.json");

type Input = Parameters<typeof mailFolderManage.run>[0];
type BookInput = Parameters<typeof contactsBookManage.run>[0];

const EVERY_ACTION: Input[] = [
  { action: "create", name: "Invoices", parentId: "mb-archive" },
  { action: "create", name: "Invoices" },
  { action: "rename", mailboxId: "mb-2024", name: "2025" },
  { action: "move", mailboxId: "mb-2024", parentId: "mb-archive" },
  { action: "move", mailboxId: "mb-2024", parentId: null },
  { action: "delete", mailboxId: "mb-2024" },
];

const EVERY_BOOK_ACTION: BookInput[] = [
  { action: "create", name: "Clients" },
  { action: "rename", bookId: "bk-2", name: "Clients" },
  { action: "delete", bookId: "bk-2" },
];

const SOURCES = new URL("../../src/", import.meta.url);

/**
 * Every file under `src/` that could put the method on the wire, as a path
 * relative to `src/`.
 *
 * The double-quoted form is what an invocation is written with, so a type file
 * or a comment naming the method in prose is not counted as an emitter — it
 * writes nothing, and listing it would make this assertion a list of mentions.
 */
function filesNaming(method: string): string[] {
  return readdirSync(SOURCES, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => readFileSync(new URL(entry, SOURCES), "utf8").includes(`"${method}"`))
    .sort();
}

/** Runs one call and hands back every method it put on the wire. */
async function emit(input: Input): Promise<Invocation[]> {
  const { context, requests } = fakeTransport([
    set.created,
    set.updated,
    set.destroyed,
    set.updated,
  ]);

  await mailFolderManage.run(input, context);

  return requests.flatMap((request) => request.methodCalls);
}

/** The same, for the address book side of the invariant. */
async function emitBook(input: BookInput): Promise<Invocation[]> {
  const { context, requests } = fakeTransport([
    bookSet.created,
    bookSet.updated,
    bookSet.destroyed,
  ]);

  await contactsBookManage.run(input, context);

  return requests.flatMap((request) => request.methodCalls);
}

describe("no folder write can take messages with it", () => {
  it("is emitted from one place only, which the cases below cover", () => {
    // The cases are written by hand against a single module. They only stand for
    // *every* emitted `Mailbox/set` for as long as that module is the only place
    // naming the method: this goes red the day a second emitter appears, and the
    // three assertions under it stop being exhaustive by coincidence of surface.
    expect(filesNaming("Mailbox/set")).toEqual(["domains/mail/folder-manage.ts"]);
  });

  it("states the cascade, false, on every action", async () => {
    for (const input of EVERY_ACTION) {
      const calls = await emit(input);

      expect(calls).toHaveLength(1);

      for (const [name, args] of calls) {
        expect(name).toBe("Mailbox/set");
        // Present, and false. An absent key would leave the answer to the server.
        expect(Object.hasOwn(args, "onDestroyRemoveEmails")).toBe(true);
        expect(args.onDestroyRemoveEmails).toBe(false);
      }
    }
  });

  it("cannot be talked into the cascade through its own input", async () => {
    // A caller — or a message the model read — asking for the flag by name.
    const raw = {
      action: "delete",
      mailboxId: "mb-2024",
      onDestroyRemoveEmails: true,
      onSuccessDestroyEmail: true,
    };

    const parsed = mailFolderManage.inputSchema.parse(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "onDestroyRemoveEmails")).toBe(false);
    expect(Object.hasOwn(parsed, "onSuccessDestroyEmail")).toBe(false);

    const args = (await emit(parsed as Input))[0]?.[1];
    expect(args?.onDestroyRemoveEmails).toBe(false);
  });

  it("never touches a message while writing a folder", async () => {
    for (const input of EVERY_ACTION) {
      const calls = await emit(input);

      expect(calls.map(([name]) => name)).not.toContain("Email/set");
    }
  });

  it("deletes the folder alone: one id, no update alongside it", async () => {
    const args = (await emit({ action: "delete", mailboxId: "mb-2024" }))[0]?.[1];

    expect(args?.destroy).toEqual(["mb-2024"]);
    expect(args?.update).toBeUndefined();
    expect(args?.create).toBeUndefined();
  });
});

describe("no address book write can take contact cards with it", () => {
  it("is emitted from one place only, which the cases below cover", () => {
    // Same reasoning as the folder above: the hand-written cases stand for every
    // emitted `AddressBook/set` only while one module names the method.
    expect(filesNaming("AddressBook/set")).toEqual(["domains/contacts/book-manage.ts"]);
  });

  it("states the cascade, false, on every action", async () => {
    for (const input of EVERY_BOOK_ACTION) {
      const calls = await emitBook(input);

      expect(calls).toHaveLength(1);

      for (const [name, args] of calls) {
        expect(name).toBe("AddressBook/set");
        // Present, and false. An absent key would leave the answer to the server.
        expect(Object.hasOwn(args, "onDestroyRemoveContents")).toBe(true);
        expect(args.onDestroyRemoveContents).toBe(false);
      }
    }
  });

  it("cannot be talked into the cascade through its own input", async () => {
    // A caller — or a card the model read — asking for the flag by name.
    const raw = {
      action: "delete",
      bookId: "bk-2",
      onDestroyRemoveContents: true,
      onSuccessDestroyCard: true,
    };

    const parsed = contactsBookManage.inputSchema.parse(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "onDestroyRemoveContents")).toBe(false);
    expect(Object.hasOwn(parsed, "onSuccessDestroyCard")).toBe(false);

    const args = (await emitBook(parsed as BookInput))[0]?.[1];
    expect(args?.onDestroyRemoveContents).toBe(false);
  });

  it("never touches a card while writing a book", async () => {
    for (const input of EVERY_BOOK_ACTION) {
      const calls = await emitBook(input);

      expect(calls.map(([name]) => name)).not.toContain("ContactCard/set");
    }
  });

  it("deletes the book alone: one id, no update alongside it", async () => {
    const args = (await emitBook({ action: "delete", bookId: "bk-2" }))[0]?.[1];

    expect(args?.destroy).toEqual(["bk-2"]);
    expect(args?.update).toBeUndefined();
    expect(args?.create).toBeUndefined();
  });
});
