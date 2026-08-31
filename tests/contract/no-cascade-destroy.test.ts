import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mailFolderManage } from "../../src/domains/mail/folder-manage.js";
import type { Invocation, SetResponse } from "../../src/jmap/types/core.js";
import type { Mailbox } from "../../src/jmap/types/mail.js";
import { fakeTransport, loadFixture } from "../fixtures/client.js";

/**
 * Contract: deleting a folder never deletes the messages inside it.
 *
 * `onDestroyRemoveEmails` is one word on the wire, and its absence is not a
 * refusal — the server falls back on a default this project does not own. Every
 * `Mailbox/set` this server emits states it, and states it false, so a folder
 * write can never become a message loss whatever the server's defaults are.
 */

const set = loadFixture<Record<string, SetResponse<Mailbox>>>("mailbox-set.json");

type Input = Parameters<typeof mailFolderManage.run>[0];

const EVERY_ACTION: Input[] = [
  { action: "create", name: "Invoices", parentId: "mb-archive" },
  { action: "create", name: "Invoices" },
  { action: "rename", mailboxId: "mb-2024", name: "2025" },
  { action: "move", mailboxId: "mb-2024", parentId: "mb-archive" },
  { action: "move", mailboxId: "mb-2024", parentId: null },
  { action: "delete", mailboxId: "mb-2024" },
];

const SOURCES = new URL("../../src/", import.meta.url);

/** Every file under `src/` naming the method, as a path relative to `src/`. */
function filesNamingMailboxSet(): string[] {
  return readdirSync(SOURCES, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => readFileSync(new URL(entry, SOURCES), "utf8").includes("Mailbox/set"))
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

describe("no folder write can take messages with it", () => {
  it("is emitted from one place only, which the cases below cover", () => {
    // The cases are written by hand against a single module. They only stand for
    // *every* emitted `Mailbox/set` for as long as that module is the only place
    // naming the method: this goes red the day a second emitter appears, and the
    // three assertions under it stop being exhaustive by coincidence of surface.
    expect(filesNamingMailboxSet()).toEqual(["domains/mail/folder-manage.ts"]);
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
