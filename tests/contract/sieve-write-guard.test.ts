import { readdirSync, readFileSync } from "node:fs";
import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { sieveWritingDomain } from "../../src/domains/sieve/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type { JmapRequest } from "../../src/jmap/types/core.js";
import { CAPABILITY_MAIL, CAPABILITY_SIEVE } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import { MAX_IDS_PER_CALL } from "../../src/shared/batch.js";
import { fakeTransport } from "../fixtures/client.js";
import {
  scriptBlobs,
  sieveCreated,
  sieveGet,
  sieveUpdated,
  sieveValid,
} from "../fixtures/sieve.js";

/**
 * The invariant this file exists for: on the Sieve writing surface, what a call
 * stores and what a call makes run are never the same request.
 *
 * Three activation paths exist and only two are arguments: the `isActive`
 * property is the third, and a `SieveScript/set` carrying it in a creation or an
 * update would switch the mail flow under a confirmation that spoke of storing
 * text. Every assertion below is a variation on that: a store emits no live
 * activation, an activation emits no object write, and a destruction emits
 * nothing at all until the confirmation comes back true.
 *
 * Written over `sieveWritingDomain.tools`, so a tool added to the manifest is
 * held to the same guarantees the day it lands.
 */

const VALID = 'require ["fileinto"];\nfileinto "Invoices";\n';

/** A `SieveScript/set` that only moved the active script: nothing per id. */
const SET_OK = { accountId: "acc-1", oldState: "sieve-state-1", newState: "sieve-state-2" };

const DESTROYED = { ...SET_OK, destroyed: ["sc-1"] };

type Handler = (
  args: unknown,
  ctx: { mcpReq: { inputResponses?: Record<string, unknown>; envelope?: Record<string, unknown> } },
) => Promise<unknown>;

const CONFIRMED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: true } } } },
};
const DECLINED = {
  mcpReq: { inputResponses: { confirm: { action: "accept", content: { confirm: false } } } },
};
const UNANSWERED = { mcpReq: {} };

function writingSurface(responses: unknown[], capabilities: Record<string, unknown> | null) {
  const { context, requests, blobs } = fakeTransport(responses, { blobs: scriptBlobs });
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [sieveWritingDomain],
    session: advertisingSieve(context.session),
    client: context.client,
    policy: DEFAULT_POLICY,
    blobs: context.blobs,
  });

  return { handlers, requests, blobs, write: handlers.get("sieve_write") as Handler };
}

/**
 * The session fixture, plus the Sieve capability it does not advertise.
 *
 * The account it stands for is a plain mail account; gating is tested on its own
 * below, and a manifest registering nothing here would make every assertion of
 * this file pass on an empty handler map.
 */
function advertisingSieve(session: JmapSession): JmapSession {
  return Object.assign(Object.create(session) as JmapSession, {
    has: (uri: string) => uri === CAPABILITY_SIEVE || session.has(uri),
  });
}

function fakeServer(registered: string[]): McpServer {
  return {
    registerTool(name: string) {
      registered.push(name);
    },
  } as unknown as McpServer;
}

function sessionWith(capabilities: readonly string[]): JmapSession {
  return { has: (uri: string) => capabilities.includes(uri) } as unknown as JmapSession;
}

function methodsOf(requests: JmapRequest[]): string[] {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

function writesIn(requests: JmapRequest[]): string[] {
  return methodsOf(requests).filter((method) => method.endsWith("/set"));
}

function scriptSets(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests.flatMap((request) =>
    request.methodCalls
      .filter(([name]) => name === "SieveScript/set")
      .map(([, args]) => args as Record<string, unknown>),
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

/**
 * Every path this surface can take to a `SieveScript/set`, and what the server
 * has to answer along the way.
 *
 * `stores` says which side of the split the path is on: a store writes objects
 * and moves nothing, an activation moves what runs and writes no object. No path
 * does both, which is the whole of what this table is here to check.
 */
const PATHS: {
  name: string;
  input: Record<string, unknown>;
  responses: unknown[];
  stores: boolean;
}[] = [
  {
    name: "a creation",
    input: { action: "store", name: "invoices", script: VALID },
    responses: [sieveValid(), sieveCreated()],
    stores: true,
  },
  {
    name: "a correction",
    input: { action: "store", name: "newsletters", script: VALID, id: "sc-1" },
    responses: [sieveGet(), sieveValid(), sieveUpdated("sc-1")],
    stores: true,
  },
  {
    name: "a correction of the active script",
    input: { action: "store", name: "invoices", script: VALID, id: "sc-3" },
    responses: [sieveGet(), sieveValid(), sieveUpdated("sc-3")],
    stores: true,
  },
  {
    name: "an activation",
    input: { action: "activate", id: "sc-2" },
    responses: [sieveGet(), SET_OK],
    stores: false,
  },
  {
    name: "a deactivation",
    input: { action: "deactivate" },
    responses: [sieveGet(), SET_OK],
    stores: false,
  },
  {
    name: "a destruction",
    input: { action: "delete", ids: ["sc-1"] },
    responses: [sieveGet(), DESTROYED],
    stores: false,
  },
];

/**
 * What it takes to reach each destroying branch, hand-written.
 *
 * Derived arguments cannot get here: every one of these three has to survive a
 * `precheck` that reads the account's scripts, and a set of ids invented from
 * the schema would be refused before the confirmation is ever due. The
 * exhaustiveness test below is what keeps the table honest.
 */
const DESTROYING: Record<
  string,
  { tool: string; input: Record<string, unknown>; responses: unknown[] }
> = {
  "an activation": {
    tool: "sieve_write",
    input: { action: "activate", id: "sc-2" },
    responses: [sieveGet(), SET_OK],
  },
  "a deactivation": {
    tool: "sieve_write",
    input: { action: "deactivate" },
    responses: [sieveGet(), SET_OK],
  },
  "a destruction": {
    tool: "sieve_write",
    input: { action: "delete", ids: ["sc-1"] },
    responses: [sieveGet(), DESTROYED],
  },
};

const DESTROYERS = sieveWritingDomain.tools.filter((tool) => tool.classes.includes("destroy"));

const SOURCES = new URL("../../src/", import.meta.url);

/** Every file under `src/` whose text matches, as a path relative to `src/`. */
function filesMatching(pattern: RegExp): string[] {
  return readdirSync(SOURCES, { recursive: true, encoding: "utf8" })
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".ts"))
    .filter((entry) => pattern.test(readFileSync(new URL(entry, SOURCES), "utf8")))
    .sort();
}

describe("the writing manifest", () => {
  it("names every destroying tool in the cases below, so none escapes them", () => {
    const covered = [...new Set(Object.values(DESTROYING).map((each) => each.tool))].sort();

    expect(DESTROYERS.map((tool) => tool.name).sort()).toEqual(covered);
  });

  it("classifies as a destruction everything but the store", () => {
    const tool = sieveWritingDomain.tools.find((each) => each.name === "sieve_write");

    expect([...(tool?.classes ?? [])].sort()).toEqual(["destroy", "draft"]);
    expect(tool?.classify({ action: "store", name: "a", script: VALID } as never)).toBe("draft");
    for (const action of ["activate", "deactivate", "delete"]) {
      expect(tool?.classify({ action } as never)).toBe("destroy");
    }
  });

  it.each(sieveWritingDomain.tools.map((tool) => tool.name))(
    "%s shares the sieve_ prefix",
    (name) => {
      expect(name.startsWith("sieve_")).toBe(true);
    },
  );
});

describe("gating", () => {
  it("registers the writing tools on a session advertising Sieve", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveWritingDomain],
      session: sessionWith([CAPABILITY_SIEVE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(sieveWritingDomain.tools.map((tool) => tool.name));
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the capability, and names the one that is missing", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveWritingDomain],
      session: sessionWith([CAPABILITY_MAIL]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "sieve-writing", missing: [CAPABILITY_SIEVE] }]);
  });
});

describe("an emitted write", () => {
  it.each(PATHS)("$name never carries isActive", async ({ input, responses }) => {
    const { write, requests } = writingSurface(responses, { elicitation: {} });

    await write(input, CONFIRMED);

    const emitted = scriptSets(requests);
    // Vacuously true if nothing was written, so the count is asserted first.
    expect(emitted).toHaveLength(1);
    // The third activation path, and the one no argument name gives away: a
    // creation or a patch carrying it activates the script on the spot.
    expect(JSON.stringify(emitted[0])).not.toContain("isActive");
  });

  it.each(PATHS)("$name states both activation arguments", async ({ input, responses }) => {
    const { write, requests } = writingSurface(responses, { elicitation: {} });

    await write(input, CONFIRMED);

    const emitted = scriptSets(requests);
    expect(emitted).toHaveLength(1);
    // Written rather than omitted, on every path: a server default is not a
    // guarantee, and an absent argument shows up on no unit test.
    expect(Object.hasOwn(emitted[0] as object, "onSuccessActivateScript")).toBe(true);
    expect(Object.hasOwn(emitted[0] as object, "onSuccessDeactivateScript")).toBe(true);
  });

  it.each(PATHS.filter((path) => path.stores))(
    "$name activates nothing",
    async ({ input, responses }) => {
      const { write, requests } = writingSurface(responses, { elicitation: {} });

      await write(input, CONFIRMED);

      for (const args of scriptSets(requests)) {
        expect(args.onSuccessActivateScript).toBeNull();
        expect(args.onSuccessDeactivateScript).toBeNull();
      }
    },
  );

  it.each(PATHS.filter((path) => !path.stores))(
    "$name writes no object",
    async ({ input, responses }) => {
      const { write, requests } = writingSurface(responses, { elicitation: {} });

      await write(input, CONFIRMED);

      for (const args of scriptSets(requests)) {
        expect(args.create).toBeUndefined();
        expect(args.update).toBeUndefined();
      }
    },
  );

  it("keeps a destruction from travelling with anything that activates", async () => {
    const { write, requests } = writingSurface([sieveGet(), DESTROYED], { elicitation: {} });

    await write({ action: "delete", ids: ["sc-1"] }, CONFIRMED);

    const args = scriptSets(requests)[0] as Record<string, unknown>;
    expect(args.destroy).toEqual(["sc-1"]);
    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.onSuccessDeactivateScript).toBeNull();
  });
});

/**
 * The script the vacation response owns, aimed at from every action that could
 * name it. `deactivate` is absent because it names nothing: what it switches off
 * is whatever is active, and turning the reply off that way is a state the
 * account can be in without anything being lost.
 */
const AT_THE_VACATION_SCRIPT: { action: string; input: Record<string, unknown> }[] = [
  { action: "store", input: { action: "store", name: "away", script: VALID, id: "sc-vac" } },
  { action: "activate", input: { action: "activate", id: "sc-vac" } },
  { action: "delete", input: { action: "delete", ids: ["sc-vac"] } },
];

describe("the script the vacation response owns", () => {
  it.each(AT_THE_VACATION_SCRIPT)(
    "$action never reaches it, whatever the answer to the question",
    async ({ input }) => {
      const { write, requests, blobs } = writingSurface(
        [sieveGet(), sieveValid(), sieveUpdated("sc-vac")],
        { elicitation: {} },
      );

      const result = await write(input, CONFIRMED);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("vacation_manage");
      // Nothing written and nothing uploaded: the refusal lands before the text
      // of a would-be replacement ever leaves the machine.
      expect(writesIn(requests)).toEqual([]);
      expect(blobs.uploads).toEqual([]);
    },
  );
});

describe("a destroying Sieve call", () => {
  it.each(Object.entries(DESTROYING))(
    "%s is refused outright on a client that cannot be asked",
    async (_case, { tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { roots: {} });

      const result = await handlers.get(tool)?.(input, UNANSWERED);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("elicitation");
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s is put to the user, and changes nothing while it waits",
    async (_case, { tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      const result = await handlers.get(tool)?.(input, UNANSWERED);

      expect(isInputRequiredResult(result)).toBe(true);
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s emits reads at most when the confirmation comes back false",
    async (_case, { tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(tool)?.(input, DECLINED);

      // A read may precede the question — `precheck` and `summarize` both run
      // before it by design, so a doomed call is never put to the user and the
      // question can name what it is about. Nothing else may be emitted: the
      // assertion is on every method, not only on the `/set` that would write.
      expect(writesIn(requests)).toEqual([]);
      for (const method of methodsOf(requests)) {
        expect(method === "SieveScript/get" || method === "SieveScript/query").toBe(true);
      }
    },
  );

  it.each(Object.entries(DESTROYING))(
    "%s goes through only once the confirmation is granted",
    async (_case, { tool, input, responses }) => {
      const { handlers, requests } = writingSurface(responses, { elicitation: {} });

      await handlers.get(tool)?.(input, CONFIRMED);

      expect(scriptSets(requests)).toHaveLength(1);
    },
  );
});

describe("the refusals that precede the question", () => {
  it("refuses a batch past the hard ceiling, before a single script is read", async () => {
    const { write, requests } = writingSurface([], { elicitation: {} });

    const ids = Array.from({ length: MAX_IDS_PER_CALL + 1 }, (_, index) => `sc-${index}`);
    const result = await write({ action: "delete", ids }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain(`batches of ${MAX_IDS_PER_CALL}`);
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses to destroy the vacation script, which the server would not", async () => {
    // The server's destroy branch tests the active-script condition and nothing
    // else (`sieve/set.rs:329-351`): here the client is the only guard there is.
    const { write, requests } = writingSurface([sieveGet(), DESTROYED], { elicitation: {} });

    const result = await write({ action: "delete", ids: ["sc-vac"] }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("vacation_manage");
    expect(writesIn(requests)).toEqual([]);
  });

  it("refuses to activate an id the account does not hold, which the server drops in silence", async () => {
    // `sieve/set.rs:97-100` clears the argument and answers a success that
    // activated nothing, so a call that reached the server would read as done.
    const { write, requests } = writingSurface([sieveGet(), SET_OK], { elicitation: {} });

    const result = await write({ action: "activate", id: "sc-nope" }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(writesIn(requests)).toEqual([]);
  });
});

describe("the two writes, read off the sources", () => {
  it("has one module and one only building an activation", () => {
    // Both arguments are written in one place, so a second module reaching for
    // the mail flow shows up here rather than in a review.
    expect(filesMatching(/onSuccess(Activate|Deactivate)Script:/)).toEqual([
      "domains/sieve/edit.ts",
    ]);
  });

  it("has one module and one only building a Sieve destruction", () => {
    const sieveSources = filesMatching(/destroy:\s*\[/).filter((path) =>
      path.startsWith("domains/sieve/"),
    );

    expect(sieveSources).toEqual(["domains/sieve/write.ts"]);
  });
});
