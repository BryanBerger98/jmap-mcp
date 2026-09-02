import { isInputRequiredResult, type McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { DEFAULT_POLICY, type WritePolicy } from "../../src/config/policy.js";
import { sieveVacationDomain } from "../../src/domains/sieve/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import type { JmapRequest } from "../../src/jmap/types/core.js";
import {
  CAPABILITY_MAIL,
  CAPABILITY_SIEVE,
  CAPABILITY_VACATION,
} from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";
import type { ToolDefinition } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";
import { VACATION_WINDOW, vacationGet, vacationUpdated, vacationWith } from "../fixtures/sieve.js";

/**
 * The invariant this file exists for: the vacation response answers strangers,
 * and only a call that asked for that may switch it on.
 *
 * One property does it — `isEnabled` — and the server preserves it across every
 * other change (`vacation/set.rs:144`), so an update carrying it unasked would
 * start answering the account's whole correspondence under a confirmation that
 * spoke of rewording a message. Every assertion below is a variation on that: a
 * call that did not name it never writes it, a call that did never runs without
 * being confirmed, and neither ever reaches for a Sieve script.
 *
 * The last one is not a nicety. Stalwart grants the two capabilities through two
 * independent permissions (`api/session.rs:113` and `:118`), and this manifest is
 * gated on the vacation one alone: a `SieveScript/*` method emitted here would
 * fail outright on an account that holds one and not the other.
 */

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

function vacationSurface(
  responses: unknown[],
  capabilities: Record<string, unknown> | null,
  policy: WritePolicy = DEFAULT_POLICY,
) {
  const { context, requests } = fakeTransport(responses, { policy });
  const handlers = new Map<string, Handler>();

  compose({
    server: {
      registerTool(name: string, _config: unknown, cb: Handler) {
        handlers.set(name, cb);
      },
      ...(capabilities === null ? {} : { server: { getClientCapabilities: () => capabilities } }),
    } as unknown as McpServer,
    domains: [sieveVacationDomain],
    session: advertisingVacation(context.session),
    client: context.client,
    policy,
    blobs: context.blobs,
  });

  return { handlers, requests, manage: handlers.get("vacation_manage") as Handler };
}

/**
 * The session fixture, plus the vacation capability it does not advertise — and
 * not the Sieve one.
 *
 * Deliberately the narrower of the two accounts: a tool reaching for a script
 * would still be answered by the fake transport, but the composition it runs
 * under here is the one where that call could not have been made.
 */
function advertisingVacation(session: JmapSession): JmapSession {
  return Object.assign(Object.create(session) as JmapSession, {
    has: (uri: string) => uri === CAPABILITY_VACATION || session.has(uri),
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

function vacationSets(requests: JmapRequest[]): Record<string, unknown>[] {
  return requests.flatMap((request) =>
    request.methodCalls
      .filter(([name]) => name === "VacationResponse/set")
      .map(([, args]) => args as Record<string, unknown>),
  );
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}

/**
 * The smallest input the tool's own schema accepts, with the branch named.
 *
 * Derived from the schema rather than written down, so a tool added to this
 * manifest is executed by the walk below the day it lands. The candidates start
 * with the field's own enum options, which is what makes an `action` resolvable
 * at all: no generic value satisfies a closed list.
 */
function minimalArguments(
  tool: ToolDefinition,
  seed: Record<string, unknown> = {},
): Record<string, unknown> {
  const shape = (tool.inputSchema as unknown as { shape?: Record<string, ZodType> }).shape;
  if (shape === undefined)
    throw new Error(`${tool.name}: its schema exposes no shape to derive from`);

  const args: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(shape)) {
    const candidates = [seed[key], ...optionsOf(field), ["x"], "x", 1, true, {}];
    const seeded = seed[key] !== undefined && field.safeParse(seed[key]).success;

    if (!seeded && field.safeParse(undefined).success) continue;

    const value = candidates.find(
      (candidate) => candidate !== undefined && field.safeParse(candidate).success,
    );
    if (value === undefined) {
      throw new Error(`${tool.name}: no minimal value found for the required field ${key}`);
    }
    args[key] = value;
  }

  return tool.inputSchema.parse(args) as Record<string, unknown>;
}

/** The values a closed list accepts, when the field is one. */
function optionsOf(field: ZodType): unknown[] {
  const options = (field as unknown as { options?: unknown }).options;
  return Array.isArray(options) ? options : [];
}

/**
 * Every path this surface can take to a `VacationResponse/set`.
 *
 * `toggles` says whether the call names `isEnabled`, which is the only thing
 * that separates rewording an away message from answering everybody who writes.
 */
const PATHS: {
  name: string;
  input: Record<string, unknown>;
  responses: unknown[];
  toggles: boolean;
}[] = [
  {
    name: "a change of subject",
    input: { action: "set", subject: "Away until Monday" },
    responses: [vacationGet(), vacationUpdated()],
    toggles: false,
  },
  {
    name: "a cleared body",
    input: { action: "set", htmlBody: null },
    responses: [vacationGet(), vacationUpdated()],
    toggles: false,
  },
  {
    name: "a change of window",
    input: { action: "set", fromDate: VACATION_WINDOW.from, toDate: null },
    responses: [vacationGet(), vacationUpdated()],
    toggles: false,
  },
  {
    name: "a switch on",
    input: { action: "set", isEnabled: true },
    responses: [vacationGet(), vacationUpdated()],
    toggles: true,
  },
  {
    name: "a switch off",
    input: { action: "set", isEnabled: false },
    responses: [vacationGet(vacationWith({ isEnabled: true })), vacationUpdated()],
    toggles: true,
  },
  {
    name: "a switch on that also rewords the reply",
    input: { action: "set", isEnabled: true, subject: "Away", textBody: "Back on the 20th." },
    responses: [vacationGet(), vacationUpdated()],
    toggles: true,
  },
];

const TOGGLES = PATHS.filter((path) => path.toggles);

describe("the vacation manifest", () => {
  it("registers the tool on a session advertising the vacation response alone", () => {
    // Without Sieve: the two capabilities come from two permissions, and an
    // account holding only this one still has an automatic reply to manage.
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveVacationDomain],
      session: sessionWith([CAPABILITY_VACATION]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual(sieveVacationDomain.tools.map((tool) => tool.name));
    expect(registered.length).toBeGreaterThan(0);
    expect(report.skipped).toEqual([]);
  });

  it("registers nothing without the capability, and names the one that is missing", () => {
    const registered: string[] = [];

    const report = compose({
      server: fakeServer(registered),
      domains: [sieveVacationDomain],
      session: sessionWith([CAPABILITY_MAIL, CAPABILITY_SIEVE]),
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([{ domain: "sieve-vacation", missing: [CAPABILITY_VACATION] }]);
  });

  it("declares the two classes a reply can reach, and reads the toggle off the arguments", () => {
    const tool = sieveVacationDomain.tools.find((each) => each.name === "vacation_manage");

    expect([...(tool?.classes ?? [])].sort()).toEqual(["draft", "send"]);
    expect(tool?.classify({ action: "show" } as never)).toBe("draft");
    expect(tool?.classify({ action: "set", subject: "Away" } as never)).toBe("draft");
    // Both directions: switching the reply off is as much a claim about what the
    // account is doing as switching it on.
    expect(tool?.classify({ action: "set", isEnabled: true } as never)).toBe("send");
    expect(tool?.classify({ action: "set", isEnabled: false } as never)).toBe("send");
  });
});

describe("an emitted vacation write", () => {
  it.each(PATHS)("$name updates the singleton and nothing else", async ({ input, responses }) => {
    const { manage, requests } = vacationSurface(responses, { elicitation: {} });

    await manage(input, CONFIRMED);

    const emitted = vacationSets(requests);
    // Vacuously true if nothing was written, so the count is asserted first.
    expect(emitted).toHaveLength(1);
    expect(Object.keys(emitted[0]?.update as object)).toEqual(["singleton"]);
    // The server refuses both on a singleton, and the arguments type makes
    // neither representable: the assertion is here for the day it is loosened.
    expect(emitted[0]?.create).toBeUndefined();
    expect(emitted[0]?.destroy).toBeUndefined();
  });

  it.each(PATHS.filter((path) => !path.toggles))(
    "$name never carries isEnabled",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { elicitation: {} });

      await manage(input, CONFIRMED);

      const emitted = vacationSets(requests);
      expect(emitted).toHaveLength(1);
      // Not `update.singleton.isEnabled === undefined`: the whole argument
      // object is searched, so a property written anywhere else shows up too.
      expect(JSON.stringify(emitted[0])).not.toContain("isEnabled");
    },
  );

  it.each(TOGGLES)("$name writes the state the call asked for", async ({ input, responses }) => {
    const { manage, requests } = vacationSurface(responses, { elicitation: {} });

    await manage(input, CONFIRMED);

    const emitted = vacationSets(requests);
    expect(emitted).toHaveLength(1);

    const update = emitted[0]?.update as Record<string, Record<string, unknown>>;
    expect(update.singleton?.isEnabled).toBe(input.isEnabled);
  });

  it.each(PATHS)("$name touches no Sieve script", async ({ input, responses }) => {
    const { manage, requests } = vacationSurface(responses, { elicitation: {} });

    await manage(input, CONFIRMED);

    for (const method of methodsOf(requests)) {
      expect(
        method.startsWith("SieveScript/"),
        `${method} was emitted by the vacation surface`,
      ).toBe(false);
    }
  });
});

describe("a toggle of the automatic reply", () => {
  it.each(TOGGLES)(
    "$name is refused outright on a client that cannot be asked",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { roots: {} });

      const result = await manage(input, UNANSWERED);

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("elicitation");
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(TOGGLES)(
    "$name is put to the user, and changes nothing while it waits",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { elicitation: {} });

      const result = await manage(input, UNANSWERED);

      expect(isInputRequiredResult(result)).toBe(true);
      expect(writesIn(requests)).toEqual([]);
    },
  );

  it.each(TOGGLES)(
    "$name emits reads at most when the confirmation comes back false",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { elicitation: {} });

      await manage(input, DECLINED);

      // A read may precede the question: `summarize` runs before it by design, so
      // the question can name the window the reply is being switched on for.
      expect(writesIn(requests)).toEqual([]);
      for (const method of methodsOf(requests)) {
        expect(method).toBe("VacationResponse/get");
      }
    },
  );

  it.each(TOGGLES)(
    "$name goes through once the confirmation is granted",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { elicitation: {} });

      await manage(input, CONFIRMED);

      expect(vacationSets(requests)).toHaveLength(1);
    },
  );

  it("names what stops filtering in the question, without reading a script", async () => {
    const { manage, requests } = vacationSurface([vacationGet()], { elicitation: {} });

    const result = await manage({ action: "set", isEnabled: true }, UNANSWERED);

    expect(isInputRequiredResult(result)).toBe(true);
    expect(methodsOf(requests)).toEqual(["VacationResponse/get"]);
  });
});

describe("a policy that denies destructions", () => {
  /** Everything allowed but destruction, so no other rule can account for a refusal. */
  const DENYING_DESTROY: WritePolicy = {
    read: "allow",
    draft: "allow",
    send: "allow",
    destroy: "deny",
  };

  it("refuses the switch on, which the class alone would have let through", async () => {
    // `classify` returns `send` here, so the registry's own guard sees an allowed
    // class. What the call also does — stopping whatever Sieve script filters —
    // is a destruction `sieve_write deactivate` is guarded on, and only the
    // tool's `precheck` can close that gap.
    const { manage, requests } = vacationSurface(
      [vacationGet(), vacationUpdated()],
      { elicitation: {} },
      DENYING_DESTROY,
    );

    const result = await manage({ action: "set", isEnabled: true }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("policy.destroy");
    // Refused before anything was asked of the server, the read included.
    expect(methodsOf(requests)).toEqual([]);
  });

  it("leaves the switch off alone: the script it ends is the vacation one", async () => {
    const { manage, requests } = vacationSurface(
      [vacationGet(vacationWith({ isEnabled: true })), vacationUpdated()],
      { elicitation: {} },
      DENYING_DESTROY,
    );

    const result = await manage({ action: "set", isEnabled: false }, CONFIRMED);

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(vacationSets(requests)).toHaveLength(1);
  });
});

describe("a change that names no toggle", () => {
  it.each(PATHS.filter((path) => !path.toggles))(
    "$name runs without asking anything",
    async ({ input, responses }) => {
      const { manage, requests } = vacationSurface(responses, { elicitation: {} });

      const result = await manage(input, UNANSWERED);

      // No confirmation, because nothing about what the account sends moved.
      expect(isInputRequiredResult(result)).toBe(false);
      expect(vacationSets(requests)).toHaveLength(1);
      expect(textOf(result)).toContain("automatic reply: unchanged");
    },
  );
});

describe("every tool of the manifest, on the smallest call its schema accepts", () => {
  it.each(sieveVacationDomain.tools.map((tool) => [tool.name, tool] as const))(
    "%s reads the vacation response and touches no Sieve script",
    async (_name, tool) => {
      const { context, requests } = fakeTransport(Array.from({ length: 8 }, () => vacationGet()));

      await tool.run(minimalArguments(tool, { action: "show" }), context);

      const methods = methodsOf(requests);
      expect(methods.length, `${tool.name} emitted no JMAP call at all`).toBeGreaterThan(0);
      for (const method of methods) {
        expect(method.startsWith("SieveScript/")).toBe(false);
      }
    },
  );

  it.each(sieveVacationDomain.tools.map((tool) => [tool.name, tool] as const))(
    "%s asks nothing of the user on a read",
    async (_name, tool) => {
      const { context } = fakeTransport([vacationGet()]);

      // A tool of this manifest may carry a `precheck`, but a `show` must not be
      // refused by one: reading the reply commits the account to nothing.
      const refusal = await tool.precheck?.(minimalArguments(tool, { action: "show" }), context);
      expect(refusal).toBeUndefined();
    },
  );

  it("shares the vacation_ prefix, and names no tool twice", () => {
    const names = sieveVacationDomain.tools.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.startsWith("vacation_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
