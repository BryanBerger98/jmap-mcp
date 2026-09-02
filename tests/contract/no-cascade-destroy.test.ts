import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contactsBookManage } from "../../src/domains/contacts/book-manage.js";
import { filesDelete } from "../../src/domains/files/delete.js";
import { filesWrite } from "../../src/domains/files/write.js";
import { mailFolderManage } from "../../src/domains/mail/folder-manage.js";
import type { AddressBook } from "../../src/jmap/types/contacts.js";
import type { Invocation, SetResponse } from "../../src/jmap/types/core.js";
import type { FileNode } from "../../src/jmap/types/filenode.js";
import type { Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * Contract: deleting a container never deletes what it holds.
 *
 * Three containers answer to this now — a mail folder, an address book and a
 * file folder — and the invariant is word for word the same on the first two.
 * The flag is one word on the wire, and its absence is not a refusal: the server
 * falls back on a default this project does not own. Every `Mailbox/set` and
 * every `AddressBook/set` this server emits states it, and states it false, so a
 * container write can never become a content loss whatever the server's defaults
 * are.
 *
 * The file storage is the one place where the flag may be true, and the section
 * at the bottom states the narrower rule it answers to: true only where the call
 * asked for the cascade, false everywhere else, and never absent.
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

const nodeSet = loadFixture<Record<string, SetResponse<FileNode>>>("file-node-set.json");

type NodeInput = Parameters<typeof filesDelete.run>[0];
type WriteInput = Parameters<typeof filesWrite.run>[0];

/** The node writes that need no local file, and both destroying calls. */
const EVERY_NODE_WRITE: WriteInput[] = [
  { action: "create-folder", name: "Invoices" },
  { action: "create-folder", name: "Invoices", parentId: null },
  { action: "organize", ids: ["fn-3", "fn-4"], parentId: null },
];

const EVERY_NODE_DESTRUCTION: NodeInput[] = [
  { ids: ["fn-3", "fn-4"], withChildren: false },
  { ids: ["fn-1"], withChildren: true },
];

const SOURCES = new URL("../../src/", import.meta.url);

/** The one module allowed to write a share into an object of another domain. */
const SHARING_EMITTER = "domains/sharing/edit.ts";

/** Where each `/set` method belongs, so a foreign emitter stands out by path. */
const HOME_OF: Record<string, string> = {
  "Mailbox/set": "domains/mail/",
  "Calendar/set": "domains/calendar/",
  "AddressBook/set": "domains/contacts/",
  "FileNode/set": "domains/files/",
};

/**
 * A cascade written to anything but `false`.
 *
 * The type declaration is excluded by name rather than by file: `boolean` is
 * what the property is declared as, and matching it would report the type file
 * as a module that turns the cascade on. The trailing `\S` is what makes the
 * exclusion hold: without a character to consume after it, the lookahead reads
 * the space before the value and clears every line.
 */
const CASCADE_ON = /onDestroyRemoveChildren:\s*(?!false\b|boolean\b)\S/;

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

/** Every file under `src/` whose text matches, as a path relative to `src/`. */
function filesMatching(pattern: RegExp): string[] {
  return readdirSync(SOURCES, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => pattern.test(readFileSync(new URL(entry, SOURCES), "utf8")))
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

/** The same, for the two file writes that need no local file. */
async function emitNodeWrite(input: WriteInput): Promise<Invocation[]> {
  const { context, requests } = fakeTransport([
    nodeSet.createdFolder,
    nodeSet.updated,
    nodeSet.destroyed,
  ]);

  await filesWrite.run(input, context);

  return requests.flatMap((request) => request.methodCalls);
}

/** The same, for the one file tool that destroys. */
async function emitNodeDestruction(input: NodeInput): Promise<Invocation[]> {
  const { context, requests } = fakeTransport([nodeSet.destroyed]);

  await filesDelete.run(input, context);

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
    // The cases are written by hand against `folder-manage.ts`. They only stand
    // for *every* emitted `Mailbox/set` while the list below is exactly these
    // two: a third emitter goes red here, and the assertions under it stop being
    // exhaustive by coincidence of surface. The sharing one is a foreign writer,
    // held to the same flag by `sharing-write-guard.test.ts` over its own surface.
    expect(filesNaming("Mailbox/set")).toEqual([
      "domains/mail/folder-manage.ts",
      "domains/sharing/edit.ts",
    ]);
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
    // emitted `AddressBook/set` only while these two are the whole list.
    expect(filesNaming("AddressBook/set")).toEqual([
      "domains/contacts/book-manage.ts",
      "domains/sharing/edit.ts",
    ]);
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

describe("no file write takes a subtree with it unless it was asked to", () => {
  it("is emitted from three places, all building their arguments in one factory", () => {
    // Three modules name the method, and the hand-written cases below cover the
    // two that live in this domain. What keeps them exhaustive is the second
    // assertion: none of the three writes the arguments itself, so the flag and
    // `onExists` are decided in one place — including for the foreign writer,
    // which shares a node's `shareWith` and delegates the rest.
    expect(filesNaming("FileNode/set")).toEqual([
      "domains/files/delete.ts",
      "domains/files/write.ts",
      "domains/sharing/edit.ts",
    ]);

    for (const file of filesNaming("FileNode/set")) {
      expect(readFileSync(new URL(file, SOURCES), "utf8")).toContain("fileNodeSetArguments(");
    }
  });

  it("destroys from one place only, which the cases below cover", () => {
    // A second module sending `destroy` on a `FileNode/set` would be destroying
    // outside `files_delete`, hence outside the count and the confirmation. The
    // file is picked by what it writes, not by what it is called: a module named
    // anything at all is caught the moment it fills the key.
    const destroying = filesNaming("FileNode/set").filter((file) =>
      /\bdestroy:/.test(readFileSync(new URL(file, SOURCES), "utf8")),
    );

    expect(destroying).toEqual(["domains/files/delete.ts"]);
  });

  it("turns the cascade on in one module and nowhere else", () => {
    expect(filesMatching(CASCADE_ON)).toEqual(["domains/files/delete.ts"]);
  });

  it("states the cascade, false, on every write that is not a destruction", async () => {
    // The deposit is the third write, and it needs a local file: it is held to
    // the same assertion in `files-write-guard.test.ts`, over the whole surface.
    for (const input of EVERY_NODE_WRITE) {
      const calls = await emitNodeWrite(input);

      expect(calls).toHaveLength(1);

      for (const [name, args] of calls) {
        expect(name).toBe("FileNode/set");
        // Present, and false. An absent key would leave the answer to the server.
        expect(Object.hasOwn(args, "onDestroyRemoveChildren")).toBe(true);
        expect(args.onDestroyRemoveChildren).toBe(false);
      }
    }
  });

  it("states the cascade a destruction asked for, and never one it did not", async () => {
    for (const input of EVERY_NODE_DESTRUCTION) {
      const calls = await emitNodeDestruction(input);

      expect(calls).toHaveLength(1);

      for (const [name, args] of calls) {
        expect(name).toBe("FileNode/set");
        expect(Object.hasOwn(args, "onDestroyRemoveChildren")).toBe(true);
        // The one flag of the three that may be true, and only here: the subtree
        // was counted before the question, and the question named what it holds.
        expect(args.onDestroyRemoveChildren).toBe(input.withChildren);
      }
    }
  });

  it("cannot be talked into the cascade through its own input", async () => {
    // A caller — or a file the model read — asking for the flag by name.
    const raw = {
      action: "create-folder",
      name: "Invoices",
      onDestroyRemoveChildren: true,
      onExists: "replace",
    };

    const parsed = filesWrite.inputSchema.parse(raw) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "onDestroyRemoveChildren")).toBe(false);
    expect(Object.hasOwn(parsed, "onExists")).toBe(false);

    const args = (await emitNodeWrite(parsed as WriteInput))[0]?.[1];
    expect(args?.onDestroyRemoveChildren).toBe(false);
    expect(args?.onExists).toBeNull();
  });

  it("destroys the nodes alone: the ids given, no update alongside them", async () => {
    const args = (await emitNodeDestruction({ ids: ["fn-3"], withChildren: false }))[0]?.[1];

    expect(args?.destroy).toEqual(["fn-3"]);
    expect(args?.update).toBeUndefined();
    expect(args?.create).toBeUndefined();
  });
});

describe("one module writes into objects it does not own the domain of", () => {
  it("is the only place naming a calendar write at all", () => {
    // Nothing in the calendar domain writes a `Calendar/set`: managing calendars
    // themselves is out of scope there, and `calendar-write-guard.test.ts` holds
    // that over its own manifest. This extends the same ban to the whole tree,
    // where sharing is the one module with a reason to send it.
    expect(filesNaming("Calendar/set")).toEqual(["domains/sharing/edit.ts"]);
  });

  it("names all four foreign set methods from that module and no other", () => {
    // The emitter held from the top rather than method by method. A share is
    // written into four object types whose domains are elsewhere, and letting a
    // second module reach one of them would put a `shareWith` write outside the
    // confirmation and outside the patch rules that keep a third party's access
    // from being erased.
    const outsiders = Object.entries(HOME_OF).map(([method, home]) => [
      method,
      filesNaming(method).filter((file) => !file.startsWith(home)),
    ]);

    expect(Object.fromEntries(outsiders)).toEqual({
      "Mailbox/set": [SHARING_EMITTER],
      "Calendar/set": [SHARING_EMITTER],
      "AddressBook/set": [SHARING_EMITTER],
      "FileNode/set": [SHARING_EMITTER],
    });
  });

  it("writes no whole sharing map and no set of its own arguments", () => {
    const source = readFileSync(new URL(SHARING_EMITTER, SOURCES), "utf8");

    // Every path it writes goes under one beneficiary. A `shareWith` written as
    // a plain property would carry back whatever a read returned, third parties
    // included, which is the one mistake this module exists to make impossible.
    expect(source).not.toMatch(/shareWith:\s/);
    // The two keys a share has no business carrying, whatever the type.
    expect(source).not.toMatch(/\bdestroy:/);
    expect(source).not.toMatch(/\bcreate:/);
  });
});
