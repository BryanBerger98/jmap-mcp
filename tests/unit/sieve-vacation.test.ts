import { describe, expect, it } from "vitest";
import {
  buildVacationPatch,
  describeVacation,
  vacationManage,
} from "../../src/domains/sieve/vacation.js";
import { JmapClient } from "../../src/jmap/client.js";
import type { Invocation, JmapRequest, JmapResponse } from "../../src/jmap/types/core.js";
import type { VacationResponseSetArguments } from "../../src/jmap/types/sieve.js";
import type { ToolContext } from "../../src/registry/define-tool.js";
import { fakeTransport } from "../fixtures/client.js";
import {
  VACATION_RESPONSE,
  VACATION_WINDOW,
  vacationGet,
  vacationUpdated,
  vacationWith,
} from "../fixtures/sieve.js";

/**
 * The vacation response, read and written without a server.
 *
 * Two things are worth a test here and the rest follows from them: a reply that
 * is on is not a reply that is answering, and a property the call did not name
 * is a property that must not travel.
 */

/** Instants either side of the fixture window, and one inside it. */
const BEFORE = new Date("2026-09-01T09:00:00Z");
const INSIDE = new Date("2026-09-12T09:00:00Z");
const AFTER = new Date("2026-10-01T09:00:00Z");

function methodsOf(requests: { methodCalls: [string, Record<string, unknown>, string][] }[]) {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

/** The arguments of the one `VacationResponse/set` a run emitted. */
function setArgumentsOf(
  requests: { methodCalls: [string, Record<string, unknown>, string][] }[],
): VacationResponseSetArguments {
  const call = requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "VacationResponse/set");

  if (call === undefined) throw new Error("no VacationResponse/set was emitted");
  return call[1] as unknown as VacationResponseSetArguments;
}

/** The arguments of the first call by name, whatever it was. */
function argumentsOf(
  requests: { methodCalls: [string, Record<string, unknown>, string][] }[],
  method: string,
): Record<string, unknown> {
  const call = requests.flatMap((request) => request.methodCalls).find(([name]) => name === method);

  if (call === undefined) throw new Error(`no ${method} was emitted`);
  return call[1];
}

/**
 * A transport answering every call with an `error` invocation.
 *
 * `fakeTransport` serves a queue keyed on the call's own method name, which
 * cannot express the one thing this file needs it to: a method the server
 * answers under the name `error`.
 */
function refusing(type: string): { context: ToolContext; requests: JmapRequest[] } {
  const requests: JmapRequest[] = [];

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const request = JSON.parse(init.body) as JmapRequest;
    requests.push(request);

    const body: JmapResponse = {
      methodResponses: request.methodCalls.map(
        ([, , callId]): Invocation => ["error", { type }, callId],
      ),
      sessionState: "session-state-1",
    };

    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const { context } = fakeTransport([]);

  return {
    context: {
      ...context,
      client: new JmapClient({
        apiUrl: "https://mail.example.com/jmap/",
        bearerToken: "a-token",
        fetchImpl,
      }),
    },
    requests,
  };
}

describe("the state of an absence, rendered", () => {
  it("says a reply inside its window is answering", () => {
    const text = describeVacation(vacationWith({ isEnabled: true }), INSIDE);

    expect(text).toContain("automatic reply: on");
    expect(text).toContain("answering today: yes");
  });

  it("says a reply whose window has closed answers nobody, though it is on", () => {
    // The dates live inside the generated script (`vacation/set.rs:330`), so the
    // server keeps calling this one enabled: `isEnabled` alone would mislead.
    const text = describeVacation(vacationWith({ isEnabled: true }), AFTER);

    expect(text).toContain("automatic reply: on");
    expect(text).toContain("answering today: no");
    expect(text).toContain(`window closed on ${VACATION_WINDOW.to}`);
  });

  it("tells a window that has not opened yet from one that is over", () => {
    const text = describeVacation(vacationWith({ isEnabled: true }), BEFORE);

    expect(text).toContain(`window only opens on ${VACATION_WINDOW.from}`);
    expect(text).not.toContain("closed");
  });

  it("says a switched-off reply is not answering, whatever its window", () => {
    const text = describeVacation(VACATION_RESPONSE, INSIDE);

    expect(text).toContain("automatic reply: off");
    expect(text).toContain("answering today: no — the reply is switched off");
  });

  it("calls an unbounded absence endless rather than printing two empty fields", () => {
    const text = describeVacation(
      vacationWith({ isEnabled: true, fromDate: null, toDate: null }),
      INSIDE,
    );

    expect(text).toContain("window: endless");
    expect(text).toContain("answering today: yes");
  });

  it("keeps a half-bounded window from reading as an unbounded one", () => {
    const from = describeVacation(vacationWith({ toDate: null }), INSIDE);
    const to = describeVacation(vacationWith({ fromDate: null }), INSIDE);

    expect(from).toContain(`from ${VACATION_WINDOW.from} onwards, with no end`);
    expect(to).toContain(`until ${VACATION_WINDOW.to}, with no start`);
  });

  it("renders the subject and both bodies, and names the ones that are absent", () => {
    const full = describeVacation(VACATION_RESPONSE, INSIDE);
    expect(full).toContain("subject: Out of office");
    expect(full).toContain("text body: Back on the 20th.");
    expect(full).toContain("html body: <p>Back on the 20th.</p>");

    const bare = describeVacation(vacationWith({ subject: null, htmlBody: null }), INSIDE);
    expect(bare).toContain("subject: (none");
    expect(bare).toContain("html body: (none)");
  });

  it("refuses to guess when the server returns a date it cannot read", () => {
    const text = describeVacation(vacationWith({ isEnabled: true, toDate: "next monday" }), INSIDE);

    // An unreadable bound is not an absent one: reading it as absent would call
    // the account answering on the strength of a date nobody parsed.
    expect(text).toContain("answering today: unknown");
  });
});

describe("vacation_manage show", () => {
  it("reads the singleton and emits nothing else", async () => {
    const { context, requests } = fakeTransport([vacationGet()]);

    await vacationManage.run({ action: "show" }, context);

    expect(methodsOf(requests)).toEqual(["VacationResponse/get"]);
    expect(argumentsOf(requests, "VacationResponse/get").ids).toEqual(["singleton"]);
  });

  it("touches no Sieve script, though the state it reads is one script's", async () => {
    const { context, requests } = fakeTransport([vacationGet(vacationWith({ isEnabled: true }))]);

    const { text } = await vacationManage.run({ action: "show" }, context);

    expect(methodsOf(requests).some((method) => method.startsWith("SieveScript/"))).toBe(false);
    expect(text).toContain("automatic reply: on");
  });

  it("lets a refused permission travel rather than answering without it", async () => {
    // `JmapVacationResponseGet` is granted apart from the Sieve one
    // (`api/session.rs:118`), so a session advertising the capability can still
    // be refused the method. Nothing here falls back on the vacation script: the
    // state it would read is the same one, behind the permission just denied.
    const { context, requests } = refusing("forbidden");

    await expect(vacationManage.run({ action: "show" }, context)).rejects.toThrow();
    expect(methodsOf(requests)).toEqual(["VacationResponse/get"]);
  });

  it("says so when the server hands back no singleton at all", async () => {
    const { context } = fakeTransport([
      { accountId: "acc-1", state: "vacation-state-1", list: [], notFound: ["singleton"] },
    ]);

    const { text } = await vacationManage.run({ action: "show" }, context);

    expect(text).toContain("no vacation response");
  });
});

describe("the patch a set builds", () => {
  it("writes the properties the call named", () => {
    expect(buildVacationPatch({ subject: "Away", textBody: "Back soon." })).toEqual({
      subject: "Away",
      textBody: "Back soon.",
    });
  });

  it("keeps a null apart from an absent key, since they mean opposite things", () => {
    // Null clears the property (`vacation/set.rs:214-218`); absent leaves it be.
    expect(buildVacationPatch({ subject: null })).toEqual({ subject: null });
    expect(buildVacationPatch({})).toEqual({});
  });

  it("carries isEnabled only when the call named it", () => {
    expect("isEnabled" in buildVacationPatch({ subject: "Away" })).toBe(false);
    expect(buildVacationPatch({ isEnabled: false })).toEqual({ isEnabled: false });
    expect(buildVacationPatch({ isEnabled: true })).toEqual({ isEnabled: true });
  });
});

describe("vacation_manage set", () => {
  it("sends one update on the singleton, and neither a creation nor a destruction", async () => {
    const { context, requests } = fakeTransport([vacationGet(), vacationUpdated()]);

    await vacationManage.run({ action: "set", subject: "Away until Monday" }, context);

    const args = setArgumentsOf(requests);
    expect(args.update).toEqual({ singleton: { subject: "Away until Monday" } });
    expect(args.create).toBeUndefined();
    expect(args.destroy).toBeUndefined();
  });

  it("leaves isEnabled out of a change of wording", async () => {
    const { context, requests } = fakeTransport([vacationGet(), vacationUpdated()]);

    await vacationManage.run({ action: "set", subject: "Away" }, context);

    expect(JSON.stringify(setArgumentsOf(requests))).not.toContain("isEnabled");
  });

  it("states that such a call moved nothing about whether the reply answers", async () => {
    const { context } = fakeTransport([
      vacationGet(vacationWith({ isEnabled: true })),
      vacationUpdated(),
    ]);

    const { text } = await vacationManage.run({ action: "set", textBody: "Back soon." }, context);

    expect(text).toContain("automatic reply: unchanged");
    expect(text).toContain("still on");
  });

  it("clears a property the call set to null, and says it cleared it", async () => {
    const { context, requests } = fakeTransport([vacationGet(), vacationUpdated()]);

    const { text } = await vacationManage.run({ action: "set", htmlBody: null }, context);

    expect(setArgumentsOf(requests).update).toEqual({ singleton: { htmlBody: null } });
    expect(text).toContain("(cleared)");
  });

  it("reports the window and what stops filtering once the reply is switched on", async () => {
    const { context, requests } = fakeTransport([vacationGet(), vacationUpdated()]);

    const { text } = await vacationManage.run({ action: "set", isEnabled: true }, context);

    expect(setArgumentsOf(requests).update).toEqual({ singleton: { isEnabled: true } });
    expect(text).toContain("automatic reply: on");
    expect(text).toContain(`from ${VACATION_WINDOW.from} until ${VACATION_WINDOW.to}`);
    expect(text).toContain("no other Sieve script filters incoming mail");
  });

  it("hands back the server's refusal rather than a success it did not get", async () => {
    const { context } = fakeTransport([
      vacationGet(),
      {
        accountId: "acc-1",
        oldState: "vacation-state-1",
        newState: "vacation-state-1",
        notUpdated: { singleton: { type: "invalidProperties", description: "subject too long" } },
      },
    ]);

    const { text } = await vacationManage.run({ action: "set", subject: "Away" }, context);

    expect(text).toContain("Refused by the server");
    expect(text).toContain("subject too long");
    expect(text).toContain("Nothing was changed");
  });
});

describe("what makes a call a send", () => {
  it("classifies a change of wording as a draft, and a toggle as a send", () => {
    expect(vacationManage.classify({ action: "show" })).toBe("draft");
    expect(vacationManage.classify({ action: "set", subject: "Away" })).toBe("draft");
    expect(vacationManage.classify({ action: "set", isEnabled: true })).toBe("send");
    // Switching off is confirmed the same way: believing a reply is on when it
    // is off is the same failure as the other way round.
    expect(vacationManage.classify({ action: "set", isEnabled: false })).toBe("send");
  });
});

describe("what a switch on is refused for", () => {
  /** A policy that allows everything but destruction, so only one rule can bite. */
  const DENYING_DESTROY = {
    read: "allow",
    draft: "allow",
    send: "allow",
    destroy: "deny",
  } as const;

  it("refuses to switch the reply on when the policy denies destructions", async () => {
    // Switching on stops whatever was filtering, which `sieve_write deactivate`
    // reaches as a `destroy`: the registry only ever sees this call's own class.
    const { context, requests } = fakeTransport([vacationGet()], { policy: DENYING_DESTROY });

    const refusal = await vacationManage.precheck?.({ action: "set", isEnabled: true }, context);

    expect(refusal).toContain("policy.destroy");
    expect(refusal).toContain("filtering incoming mail");
    // Unconditional on the argument alone: reading the active script would take a
    // `SieveScript/get` this manifest is not gated on.
    expect(methodsOf(requests)).toEqual([]);
  });

  it("refuses it just the same when the call also rewords the reply", async () => {
    const { context } = fakeTransport([vacationGet()], { policy: DENYING_DESTROY });

    const refusal = await vacationManage.precheck?.(
      { action: "set", isEnabled: true, subject: "Away", toDate: null },
      context,
    );

    expect(refusal).toContain("Refused");
  });

  it("lets the switch off through, since nothing that was filtering is lost", async () => {
    const { context } = fakeTransport([vacationGet()], { policy: DENYING_DESTROY });

    // The active script was the vacation one already; ending it takes no filter
    // away, so the destruction the other direction carries is not there.
    const refusal = await vacationManage.precheck?.({ action: "set", isEnabled: false }, context);

    expect(refusal).toBeUndefined();
  });

  it("lets a change of wording and a read through under the same policy", async () => {
    const { context } = fakeTransport([vacationGet()], { policy: DENYING_DESTROY });

    expect(
      await vacationManage.precheck?.({ action: "set", subject: "Away" }, context),
    ).toBeUndefined();
    expect(await vacationManage.precheck?.({ action: "show" }, context)).toBeUndefined();
  });

  it("says nothing about a switch on under a policy that does not deny destructions", async () => {
    const { context } = fakeTransport([vacationGet()]);

    // The default policy confirms destructions rather than denying them, and a
    // confirmation is exactly what this call already asks for on its own class.
    const refusal = await vacationManage.precheck?.({ action: "set", isEnabled: true }, context);

    expect(refusal).toBeUndefined();
  });
});

describe("the question a toggle raises", () => {
  it("names the window it is switching on, off the stored bounds when none are given", async () => {
    const { context } = fakeTransport([vacationGet()]);

    const message = await vacationManage.summarize({ action: "set", isEnabled: true }, context);

    expect(message).toContain("Switch the automatic reply on");
    expect(message).toContain(`from ${VACATION_WINDOW.from} until ${VACATION_WINDOW.to}`);
    expect(message).toContain("Out of office");
  });

  it("says what stops filtering, without reading a script to do it", async () => {
    const { context, requests } = fakeTransport([vacationGet()]);

    const message = await vacationManage.summarize(
      { action: "set", isEnabled: true, toDate: null },
      context,
    );

    // The manifest is gated on the vacation capability alone, so a
    // `SieveScript/get` here would fail on an account that holds one permission
    // and not the other.
    expect(methodsOf(requests)).toEqual(["VacationResponse/get"]);
    expect(message).toContain("stops being the active one");
    expect(message).toContain("with no end");
  });

  it("words the other direction as plainly as the first", async () => {
    const { context } = fakeTransport([vacationGet(vacationWith({ isEnabled: true }))]);

    const message = await vacationManage.summarize({ action: "set", isEnabled: false }, context);

    expect(message).toContain("Switch the automatic reply off");
    expect(message).toContain("nothing filters incoming mail either");
  });

  it("says of a draft call that it does not touch whether the reply answers", async () => {
    const { context, requests } = fakeTransport([]);

    const message = await vacationManage.summarize({ action: "set", subject: "Away" }, context);

    // Nothing is read: a call that cannot move the active state has nothing to
    // learn from the stored object.
    expect(methodsOf(requests)).toEqual([]);
    expect(message).toContain("the subject");
    expect(message).toContain("not touched by this call");
  });
});

describe("the schema of vacation_manage", () => {
  const schema = vacationManage.inputSchema;

  it("refuses a set that names nothing to change", () => {
    expect(schema.safeParse({ action: "set" }).success).toBe(false);
    expect(schema.safeParse({ action: "set", subject: "Away" }).success).toBe(true);
  });

  it("refuses a show carrying a property, which would read as a write", () => {
    expect(schema.safeParse({ action: "show", isEnabled: true }).success).toBe(false);
    expect(schema.safeParse({ action: "show" }).success).toBe(true);
  });

  it("accepts null on every property that can be cleared", () => {
    const cleared = { action: "set", subject: null, textBody: null, htmlBody: null, toDate: null };

    expect(schema.safeParse(cleared).success).toBe(true);
  });

  it("holds the server's own ceilings, so a refusal costs no round trip", () => {
    expect(schema.safeParse({ action: "set", subject: "a".repeat(512) }).success).toBe(true);
    expect(schema.safeParse({ action: "set", subject: "a".repeat(513) }).success).toBe(false);
    expect(schema.safeParse({ action: "set", textBody: "a".repeat(2048) }).success).toBe(true);
    expect(schema.safeParse({ action: "set", textBody: "a".repeat(2049) }).success).toBe(false);
    expect(schema.safeParse({ action: "set", htmlBody: "a".repeat(2049) }).success).toBe(false);
  });

  it("takes a UTC date and nothing looser", () => {
    expect(schema.safeParse({ action: "set", fromDate: "2026-09-10T00:00:00Z" }).success).toBe(
      true,
    );
    expect(schema.safeParse({ action: "set", fromDate: "2026-09-10" }).success).toBe(false);
    expect(schema.safeParse({ action: "set", toDate: "next monday" }).success).toBe(false);
  });
});
