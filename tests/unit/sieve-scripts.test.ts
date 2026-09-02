import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { OPEN_SCOPE } from "../../src/config/recipients.js";
import { DEFAULT_BULK_CONFIRM_ABOVE } from "../../src/config/schema.js";
import {
  isVacationName,
  MAX_SCRIPT_CHARS,
  renderScriptRow,
  renderScriptText,
} from "../../src/domains/sieve/script.js";
import { sieveScripts } from "../../src/domains/sieve/scripts.js";
import { JmapClient } from "../../src/jmap/client.js";
import { JmapMethodError } from "../../src/jmap/errors.js";
import type { Invocation, JmapRequest, JmapResponse } from "../../src/jmap/types/core.js";
import type { SieveScript } from "../../src/jmap/types/sieve.js";
import { perInvocationCache, type ToolContext } from "../../src/registry/define-tool.js";
import { fakeBlobs, fakeTransport, fixtureSession } from "../fixtures/client.js";
import { SIEVE_SCRIPTS, scriptBlobs, sieveGet, sieveQuery } from "../fixtures/sieve.js";

const NONE_ACTIVE: SieveScript[] = SIEVE_SCRIPTS.map((script) => ({ ...script, isActive: false }));

function listing(scripts: readonly SieveScript[] = SIEVE_SCRIPTS) {
  return fakeTransport([sieveQuery(scripts), sieveGet(scripts)], { blobs: scriptBlobs });
}

function reading(scripts: readonly SieveScript[] = SIEVE_SCRIPTS) {
  return fakeTransport([sieveGet(scripts)], { blobs: scriptBlobs });
}

/**
 * A transport whose every method answers with an `error` invocation.
 *
 * `fakeTransport` serves a queue and names each response after the call it
 * answers, so it cannot express a method that fails: the one case this needs is
 * a server that holds the Sieve capability but refuses the account the read.
 */
function refusing(type: string): { context: ToolContext; downloads: number } {
  const traffic = { uploads: [], downloads: [] };

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JmapRequest;

    const body: JmapResponse = {
      methodResponses: request.methodCalls.map(
        ([, , callId]): Invocation => ["error", { type }, callId],
      ),
      sessionState: "session-state-1",
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    context: {
      client: new JmapClient({
        apiUrl: "https://mail.example.com/jmap/",
        bearerToken: "a-token",
        fetchImpl,
      }),
      session: fixtureSession(),
      blobs: fakeBlobs(traffic),
      files: {},
      recipients: OPEN_SCOPE,
      policy: DEFAULT_POLICY,
      bulkConfirmAbove: DEFAULT_BULK_CONFIRM_ABOVE,
      once: perInvocationCache(),
    },
    get downloads() {
      return traffic.downloads.length;
    },
  };
}

describe("sieve_scripts list", () => {
  it("spends one round trip on the query and the read together", async () => {
    const { context, requests } = listing();

    await sieveScripts.run({ action: "list" }, context);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.methodCalls.map(([name]) => name)).toEqual([
      "SieveScript/query",
      "SieveScript/get",
    ]);
    // The read takes its ids off the query rather than off a first answer.
    expect(requests[0]?.methodCalls[1]?.[1]).toMatchObject({
      "#ids": { resultOf: "0", name: "SieveScript/query", path: "/ids" },
    });
  });

  it("names every script and marks the active one", async () => {
    const { context } = listing();

    const { text } = await sieveScripts.run({ action: "list" }, context);

    for (const script of SIEVE_SCRIPTS) expect(text).toContain(script.name);
    expect(text).toContain("invoices (sc-3) is active and filters incoming mail.");
  });

  it("says outright that nothing filters when no script is active", async () => {
    const { context } = listing(NONE_ACTIVE);

    const { text } = await sieveScripts.run({ action: "list" }, context);

    expect(text).toContain("No script is active: nothing filters incoming mail right now.");
  });

  it("points the vacation script at its own tool instead of at sieve_write", async () => {
    const { context } = listing();

    const { text } = await sieveScripts.run({ action: "list" }, context);

    expect(text).toContain("vacation response — read and set it with vacation_manage");
  });

  it("puts only the name condition on the wire when filtering by name", async () => {
    const { context, requests } = listing();

    await sieveScripts.run({ action: "list", nameContains: "news" }, context);

    const [, args] = requests[0]?.methodCalls[0] ?? [];
    expect(args?.filter).toEqual({ name: "news" });
    expect(args?.sort).toEqual([{ property: "name", isAscending: true }]);
  });

  it("claims nothing about the account when the filter could hide the active script", async () => {
    const hidden = SIEVE_SCRIPTS.filter((script) => script.isActive !== true);
    const { context } = listing(hidden);

    const { text } = await sieveScripts.run({ action: "list", nameContains: "news" }, context);

    expect(text).toContain("None of the matching scripts is the active one.");
    expect(text).not.toContain("nothing filters incoming mail");
  });
});

describe("sieve_scripts show", () => {
  it("renders the text behind the blob, never the blob itself", async () => {
    const { context, blobs } = reading();

    const { text } = await sieveScripts.run({ action: "show", id: "sc-1" }, context);

    expect(blobs.downloads).toEqual([
      { blobId: "blob-sc-1", name: "newsletters", type: "application/sieve" },
    ]);
    expect(text).toContain('fileinto "Newsletters";');
    expect(text).not.toContain("blob-sc-1");
  });

  it("refuses an unknown id without attempting a download", async () => {
    const { context, blobs } = reading();

    const { text } = await sieveScripts.run({ action: "show", id: "sc-nope" }, context);

    expect(text).toContain("Refused: no Sieve script has the id sc-nope");
    expect(blobs.downloads).toEqual([]);
  });

  it("says which script is the active one it just read", async () => {
    const { context } = reading();

    const { text } = await sieveScripts.run({ action: "show", id: "sc-3" }, context);

    expect(text).toContain("active: yes — this script filters incoming mail");
  });

  it("sends a reader of the vacation script to vacation_manage", async () => {
    const { context } = reading();

    const { text } = await sieveScripts.run({ action: "show", id: "sc-vac" }, context);

    expect(text).toContain("change it with vacation_manage, not sieve_write");
  });

  it("lets a refused read travel as it came, with nothing invented in its place", async () => {
    // The capability is advertised without condition; the permission behind it
    // is not. Answering from anything else would be answering for a read that
    // never happened.
    const refused = refusing("forbidden");

    await expect(sieveScripts.run({ action: "show", id: "sc-1" }, refused.context)).rejects.toThrow(
      JmapMethodError,
    );
    expect(refused.downloads).toBe(0);
  });

  it("refuses an id without an `id` argument at the schema", () => {
    expect(sieveScripts.inputSchema.safeParse({ action: "show" }).success).toBe(false);
    expect(sieveScripts.inputSchema.safeParse({ action: "list" }).success).toBe(true);
  });
});

describe("script rendering", () => {
  it("recognises the reserved name whatever its case and padding", () => {
    expect(isVacationName("vacation")).toBe(true);
    expect(isVacationName(" Vacation ")).toBe(true);
    expect(isVacationName("vacations")).toBe(false);
    expect(isVacationName(undefined)).toBe(false);
  });

  it("leaves the active column blank on an inactive script", () => {
    expect(renderScriptRow({ id: "sc-1", name: "a", isActive: false }).active).toBe("");
    expect(renderScriptRow({ id: "sc-3", name: "b", isActive: true }).active).toBe("active");
  });

  it("hands back a short script untouched", () => {
    expect(renderScriptText("discard;\n")).toBe("discard;\n");
  });

  it("says how many bytes it cut instead of trailing off", () => {
    const text = `${"a".repeat(MAX_SCRIPT_CHARS)}éé`;

    const rendered = renderScriptText(text);

    // Two accented characters are four bytes, not two: the count is measured on
    // the part that was dropped, not guessed from its length.
    expect(rendered).toContain("[cut here: 4 more bytes of this script are not shown]");
    expect(rendered.startsWith("a".repeat(MAX_SCRIPT_CHARS))).toBe(true);
  });
});
