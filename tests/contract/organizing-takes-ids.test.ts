import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { mailOrganizingDomain } from "../../src/domains/mail/index.js";
import type { JmapRequest } from "../../src/jmap/types/core.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";

/**
 * The invariant this file exists for: an organizing tool acts on ids a human
 * saw, never on a search it runs itself.
 *
 * A tool that took a filter would decide its own scope, and Stalwart drops a
 * malformed `header` condition without an error — so a broken criterion widens
 * the set silently, and the batch lands on messages nobody ever listed. The ids
 * come from `mail_search`, whose results were rendered before anything was
 * written.
 *
 * It grows with each tool the manifest gains, without being rewritten.
 */

/** Every key that would let a call name a set instead of naming its members. */
const CRITERIA = [
  "from",
  "to",
  "subject",
  "text",
  "before",
  "after",
  "cursor",
  "filter",
  "deliveredTo",
];

/**
 * The tools that act on the folder tree rather than on a batch of messages.
 *
 * They name one folder and write one folder, so `ids` means nothing to them.
 * Listed by hand rather than detected: a message tool that quietly lost its
 * `ids` would otherwise excuse itself from the invariant.
 */
const FOLDER_TOOLS = new Set(["mail_folder_manage"]);

const TOOLS = mailOrganizingDomain.tools.map((tool) => [tool.name, tool] as const);

const BATCH_TOOLS = TOOLS.filter(([name]) => !FOLDER_TOOLS.has(name));

function keysOf(tool: ToolDefinition): string[] {
  return Object.keys((tool.inputSchema as unknown as z.ZodObject<z.ZodRawShape>).shape);
}

function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

describe("an organizing tool takes ids", () => {
  it.each(BATCH_TOOLS)("%s asks for a list of ids", (_name, tool) => {
    expect(keysOf(tool)).toContain("ids");
  });

  it.each(TOOLS)("%s carries no search criterion", (_name, tool) => {
    expect(keysOf(tool).filter((key) => CRITERIA.includes(key))).toEqual([]);
  });

  it.each(BATCH_TOOLS)(
    "%s refuses an empty list without emitting a JMAP method",
    async (_name, tool) => {
      const { context, requests } = fakeTransport([]);

      // Every argument the manifest's tools take, so the refusal is the batch
      // ceiling's doing and not a missing field's.
      const refusal = await tool.precheck?.(
        { ids: [], mailboxId: "mb-archive", add: ["seen"] },
        context,
      );

      expect(refusal).toContain("Refused");
      expect(methodsOf(requests)).toEqual([]);
    },
  );
});
