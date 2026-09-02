import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import {
  buildScriptCreation,
  buildScriptPatch,
  explainSetError,
  sieveScriptSetArguments,
} from "../../src/domains/sieve/edit.js";
import { sieveDomain, sieveWritingDomain } from "../../src/domains/sieve/index.js";
import { sieveWrite } from "../../src/domains/sieve/write.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_MAIL, CAPABILITY_SIEVE } from "../../src/jmap/types/core.js";
import type { SieveScript, SieveScriptSetArguments } from "../../src/jmap/types/sieve.js";
import { compose } from "../../src/registry/compose.js";
import { fakeTransport, UPLOADED_BLOB_ID } from "../fixtures/client.js";
import {
  SIEVE_SCRIPTS,
  scriptBlobs,
  sieveCreated,
  sieveGet,
  sieveInvalid,
  sieveUpdated,
  sieveValid,
} from "../fixtures/sieve.js";

/** A store that reads nothing: no `id`, so no script has to be resolved. */
function storing(...answers: unknown[]) {
  return fakeTransport(answers, { blobs: scriptBlobs });
}

/**
 * A store aimed at an existing script.
 *
 * The `SieveScript/get` comes first because `precheck` resolves the target
 * before anything is uploaded, and the shared cache makes it exactly one read
 * however many hooks ask for it.
 */
function correcting(...answers: unknown[]) {
  return fakeTransport([sieveGet(), ...answers], { blobs: scriptBlobs });
}

/** Every method name a run put on the wire, in order. */
function methodsOf(requests: { methodCalls: [string, Record<string, unknown>, string][] }[]) {
  return requests.flatMap((request) => request.methodCalls.map(([name]) => name));
}

/** The arguments of the one `SieveScript/set` a run emitted. */
function setArgumentsOf(
  requests: {
    methodCalls: [string, Record<string, unknown>, string][];
  }[],
): SieveScriptSetArguments {
  const call = requests
    .flatMap((request) => request.methodCalls)
    .find(([name]) => name === "SieveScript/set");

  if (call === undefined) throw new Error("no SieveScript/set was emitted");
  return call[1] as unknown as SieveScriptSetArguments;
}

const VALID = 'require ["fileinto"];\nfileinto "Invoices";\n';

/**
 * What a `SieveScript/set` that only switches the active script answers.
 *
 * Nothing per id: the activation is a property of the account, not of an object
 * in the set, so the server reports it in `newState` and nowhere else
 * (`sieve/set.rs:371-390`).
 */
const SET_OK = { accountId: "acc-1", oldState: "sieve-state-1", newState: "sieve-state-2" };

/** The same fixtures, with the active flag moved onto a script of the test's choice. */
function activeIs(id: string | undefined): SieveScript[] {
  return SIEVE_SCRIPTS.map((script) => ({ ...script, isActive: script.id === id }));
}

describe("sieve_write arguments", () => {
  it("names a creation, because a nameless one is given a random name", () => {
    expect(buildScriptCreation("invoices", "blob-1")).toEqual({
      name: "invoices",
      blobId: "blob-1",
    });
  });

  it("patches only what the call named", () => {
    expect(buildScriptPatch({ name: "invoices" })).toEqual({ name: "invoices" });
    expect(buildScriptPatch({ blobId: "blob-1" })).toEqual({ blobId: "blob-1" });
    expect(buildScriptPatch({})).toEqual({});
  });

  it("writes both activation arguments to null, on a call that creates nothing", () => {
    // Written rather than omitted: a server default is not a guarantee, and an
    // absent argument is one no test can see.
    const args = sieveScriptSetArguments("acc-1");

    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.onSuccessDeactivateScript).toBeNull();
  });

  it("lets no caller smuggle an activation past the factory", () => {
    const args = sieveScriptSetArguments("acc-1", {
      create: { new: buildScriptCreation("a", "blob-1") },
      // The cast is the test: this is what a call site drifting past the type
      // would look like, and the factory has to win anyway.
      ...({ onSuccessActivateScript: "sc-1" } as Record<string, unknown>),
    });

    expect(args.onSuccessActivateScript).toBeNull();
  });
});

describe("sieve_write store", () => {
  it("uploads, compiles, then writes — in that order and no other", async () => {
    const { context, requests, blobs } = storing(sieveValid(), sieveCreated());

    await sieveWrite.run({ action: "store", name: "invoices", script: VALID }, context);

    expect(blobs.uploads).toHaveLength(1);
    expect(blobs.uploads[0]?.contentType).toBe("application/sieve");
    expect(new TextDecoder().decode(blobs.uploads[0]?.body)).toBe(VALID);
    expect(methodsOf(requests)).toEqual(["SieveScript/validate", "SieveScript/set"]);
  });

  it("creates under the uploaded blob, carrying neither isActive nor an activation", async () => {
    const { context, requests } = storing(sieveValid(), sieveCreated());

    await sieveWrite.run({ action: "store", name: "invoices", script: VALID }, context);

    const args = setArgumentsOf(requests);
    expect(args.create).toEqual({ new: { name: "invoices", blobId: UPLOADED_BLOB_ID } });
    expect(args.update).toBeUndefined();
    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.onSuccessDeactivateScript).toBeNull();
    expect(JSON.stringify(args)).not.toContain("isActive");
  });

  it("updates an existing script with the name and the blob, and nothing else", async () => {
    // No read is queued: `run` resolves nothing, the target having been checked
    // by `precheck` before this was ever reached.
    const { context, requests } = storing(sieveValid(), sieveUpdated("sc-1"));

    await sieveWrite.run(
      { action: "store", name: "newsletters", script: VALID, id: "sc-1" },
      context,
    );

    const args = setArgumentsOf(requests);
    expect(args.update).toEqual({
      "sc-1": { name: "newsletters", blobId: UPLOADED_BLOB_ID },
    });
    expect(args.create).toBeUndefined();
    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.onSuccessDeactivateScript).toBeNull();
  });

  it("says outright that the stored script is not the one filtering mail", async () => {
    const { context } = storing(sieveValid(), sieveCreated("sc-9"));

    const { text } = await sieveWrite.run(
      { action: "store", name: "invoices", script: VALID },
      context,
    );

    expect(text).toContain("sc-9");
    expect(text).toContain("storing does not activate");
  });
});

describe("sieve_write, when the script does not compile", () => {
  it("stores nothing and hands back the compiler's own message", async () => {
    const { context, requests } = storing(sieveInvalid());

    const { text } = await sieveWrite.run(
      { action: "store", name: "invoices", script: "fileintoo;" },
      context,
    );

    expect(methodsOf(requests)).toEqual(["SieveScript/validate"]);
    expect(text).toContain('unknown command "fileintoo"');
    expect(text).toContain("line 3");
  });

  it("tells a lost upload apart from a script that is wrong", async () => {
    const { context } = storing({
      accountId: "acc-1",
      error: { type: "blobNotFound" },
    });

    const { text } = await sieveWrite.run(
      { action: "store", name: "invoices", script: VALID },
      context,
    );

    expect(text).toContain("gone by the time the server tried to compile it");
    expect(text).not.toContain("does not compile");
  });
});

describe("sieve_write, before anything is uploaded", () => {
  it("refuses the reserved name whatever its case", async () => {
    for (const name of ["vacation", "Vacation", "VACATION", " vacation "]) {
      const { context, requests, blobs } = storing();

      const refusal = await sieveWrite.precheck?.(
        { action: "store", name, script: VALID },
        context,
      );

      expect(refusal).toContain("`vacation` is the name the vacation response owns");
      expect(requests).toEqual([]);
      expect(blobs.uploads).toEqual([]);
    }
  });

  it("refuses a correction aimed at the vacation script the server generates", async () => {
    const { context, blobs } = correcting();

    const refusal = await sieveWrite.precheck?.(
      { action: "store", name: "away", script: VALID, id: "sc-vac" },
      context,
    );

    expect(refusal).toContain("vacation_manage");
    expect(blobs.uploads).toEqual([]);
  });

  it("refuses an id the account does not hold", async () => {
    const { context } = correcting();

    const refusal = await sieveWrite.precheck?.(
      { action: "store", name: "away", script: VALID, id: "sc-nope" },
      context,
    );

    expect(refusal).toContain("no Sieve script has the id sc-nope");
  });

  it("lets a correction of an inactive script through without a question", async () => {
    const { context } = correcting();
    const input = { action: "store" as const, name: "newsletters", script: VALID, id: "sc-1" };

    expect(await sieveWrite.precheck?.(input, context)).toBeUndefined();
    expect(await sieveWrite.confirmWhen?.(input, context)).toBeUndefined();
  });
});

describe("sieve_write, when the target is the active script", () => {
  it("asks before writing, though the call is only a draft", async () => {
    const { context } = correcting();
    const input = { action: "store" as const, name: "invoices", script: VALID, id: "sc-3" };

    // The class stays honest about what the call does; the question is what
    // carries the consequence the class cannot express.
    expect(sieveWrite.classify(input)).toBe("draft");

    const reason = await sieveWrite.confirmWhen?.(input, context);
    expect(reason).toContain("invoices (sc-3)");
    expect(reason).toContain("currently filtering incoming mail");
  });

  it("asks nothing when the account has no active script at all", async () => {
    const inactive: SieveScript[] = SIEVE_SCRIPTS.map((script) => ({
      ...script,
      isActive: false,
    }));
    const { context } = fakeTransport([sieveGet(inactive)], { blobs: scriptBlobs });

    const reason = await sieveWrite.confirmWhen?.(
      { action: "store", name: "invoices", script: VALID, id: "sc-3" },
      context,
    );

    expect(reason).toBeUndefined();
  });

  it("spends one read on the target however many hooks ask for it", async () => {
    const { context, requests } = correcting();
    const input = { action: "store" as const, name: "invoices", script: VALID, id: "sc-3" };

    await sieveWrite.summarize(input, context);
    await sieveWrite.precheck?.(input, context);
    await sieveWrite.confirmWhen?.(input, context);

    expect(methodsOf(requests)).toEqual(["SieveScript/get"]);
  });
});

describe("sieve_write activate", () => {
  const ACTIVATE = { action: "activate" as const, id: "sc-2" };

  it("classifies as a destruction, because a script can lose mail once it runs", () => {
    expect(sieveWrite.classify(ACTIVATE)).toBe("destroy");
  });

  it("switches the active script and writes nothing else at all", async () => {
    const { context, requests } = fakeTransport([sieveGet(), SET_OK], { blobs: scriptBlobs });

    await sieveWrite.run(ACTIVATE, context);

    const args = setArgumentsOf(requests);
    expect(args.onSuccessActivateScript).toBe("sc-2");
    expect(args.onSuccessDeactivateScript).toBeNull();
    // The whole of criterion 2.7: an activation carries no object write, so the
    // confirmation the caller answered covers everything the request does.
    expect(args.create).toBeUndefined();
    expect(args.update).toBeUndefined();
    expect(args.destroy).toBeUndefined();
  });

  it("names the script, what its source can do, and what stops filtering", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize(ACTIVATE, context);

    expect(summary).toContain("aggressive (sc-2)");
    expect(summary).toContain("discard — drop messages with no copy kept anywhere");
    expect(summary).toContain("invoices (sc-3) stops filtering");
  });

  it("reads the source once, however many hooks ask what the script does", async () => {
    const { context, requests, blobs } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    await sieveWrite.summarize(ACTIVATE, context);
    await sieveWrite.precheck?.(ACTIVATE, context);

    expect(methodsOf(requests)).toEqual(["SieveScript/get"]);
    expect(blobs.downloads).toHaveLength(1);
  });

  it("says the vacation response goes dark when it is what was active", async () => {
    const { context } = fakeTransport([sieveGet(activeIs("sc-vac"))], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize(ACTIVATE, context);

    expect(summary).toContain("switches that automatic reply off");
    expect(summary).toContain("sc-vac");
  });

  it("says so when nothing was filtering before", async () => {
    const { context } = fakeTransport([sieveGet(activeIs(undefined))], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize(ACTIVATE, context);

    expect(summary).toContain("adds filtering where there was none");
  });

  it("refuses a script whose source cannot be read, rather than ask about it blind", async () => {
    // Criterion 2.4: the blob the script points at has no text behind it, so
    // the confirmation could only say "this does something, we cannot say what".
    const unreadable = SIEVE_SCRIPTS.map((script) =>
      script.id === "sc-2" ? { ...script, blobId: "blob-gone" } : script,
    );
    const { context, requests } = fakeTransport([sieveGet(unreadable)], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.(ACTIVATE, context);

    expect(refusal).toContain("could not be read");
    expect(refusal).toContain("Nothing was activated");
    expect(methodsOf(requests)).toEqual(["SieveScript/get"]);
  });

  it("refuses the script the vacation response generates", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.({ action: "activate", id: "sc-vac" }, context);

    expect(refusal).toContain("vacation_manage");
  });

  it("refuses an id the account does not hold, which the server would drop in silence", async () => {
    // `sieve/set.rs:97-100` clears an unknown `onSuccessActivateScript` and
    // answers a success that activated nothing at all.
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.({ action: "activate", id: "sc-nope" }, context);

    expect(refusal).toContain("no Sieve script has the id sc-nope");
  });
});

describe("sieve_write deactivate", () => {
  const DEACTIVATE = { action: "deactivate" as const };

  it("classifies as a destruction, by symmetry with activating", () => {
    expect(sieveWrite.classify(DEACTIVATE)).toBe("destroy");
  });

  it("switches filtering off and writes nothing else", async () => {
    const { context, requests } = fakeTransport([sieveGet(), SET_OK], { blobs: scriptBlobs });

    await sieveWrite.run(DEACTIVATE, context);

    const args = setArgumentsOf(requests);
    expect(args.onSuccessDeactivateScript).toBe(true);
    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.create).toBeUndefined();
    expect(args.update).toBeUndefined();
    expect(args.destroy).toBeUndefined();
  });

  it("names the script that stops filtering, and what that leaves behind", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize(DEACTIVATE, context);

    expect(summary).toContain("invoices (sc-3)");
    expect(summary).toContain("no script filters incoming mail afterwards");
  });

  it("says the automatic reply stops when the vacation response is what is active", async () => {
    const { context } = fakeTransport([sieveGet(activeIs("sc-vac"))], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize(DEACTIVATE, context);

    expect(summary).toContain("vacation response");
  });

  it("refuses when nothing is active, and emits no write at all", async () => {
    // Criterion 3.5: the read that establishes it is the only method that goes
    // out, and `run` is never reached — the refusal comes before the question.
    const { context, requests } = fakeTransport([sieveGet(activeIs(undefined))], {
      blobs: scriptBlobs,
    });

    const refusal = await sieveWrite.precheck?.(DEACTIVATE, context);

    expect(refusal).toContain("no script is active");
    expect(methodsOf(requests)).toEqual(["SieveScript/get"]);
  });
});

describe("sieve_write delete", () => {
  it("classifies as a destruction whatever it points at", () => {
    expect(sieveWrite.classify({ action: "delete", ids: ["sc-1"] })).toBe("destroy");
  });

  it("refuses fifty-one ids before it reads anything", async () => {
    const { context, requests } = fakeTransport([], { blobs: scriptBlobs });
    const ids = Array.from({ length: 51 }, (_, index) => `sc-${index}`);

    const refusal = await sieveWrite.precheck?.({ action: "delete", ids }, context);

    expect(refusal).toContain("51 Sieve script ids were given");
    expect(requests).toEqual([]);
  });

  it("refuses an empty list, pointing at the tool that hands ids out", async () => {
    const { context, requests } = fakeTransport([], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.({ action: "delete", ids: [] }, context);

    expect(refusal).toContain("sieve_scripts");
    expect(requests).toEqual([]);
  });

  it("refuses the active script, naming the activation that blocks it", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.(
      { action: "delete", ids: ["sc-1", "sc-3"] },
      context,
    );

    expect(refusal).toContain("invoices (sc-3)");
    expect(refusal).toContain("currently filtering incoming mail");
    expect(refusal).toContain("Nothing was destroyed");
  });

  it("refuses the vacation script, where the server itself would not", async () => {
    // Criterion 4.4, and the one place in the module where the client is the
    // sole guard: `sieve/set.rs:329-351` tests the active script and nothing else.
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.({ action: "delete", ids: ["sc-vac"] }, context);

    expect(refusal).toContain("vacation_manage");
    expect(refusal).toContain("Nothing was destroyed");
  });

  it("refuses an id the account does not hold", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const refusal = await sieveWrite.precheck?.(
      { action: "delete", ids: ["sc-1", "sc-nope"] },
      context,
    );

    expect(refusal).toContain("sc-nope");
  });

  it("destroys by id alone, activating and updating nothing", async () => {
    const { context, requests } = fakeTransport(
      [sieveGet(), { ...SET_OK, destroyed: ["sc-1", "sc-2"] }],
      { blobs: scriptBlobs },
    );

    const { text } = await sieveWrite.run({ action: "delete", ids: ["sc-1", "sc-2"] }, context);

    const args = setArgumentsOf(requests);
    expect(args.destroy).toEqual(["sc-1", "sc-2"]);
    expect(args.create).toBeUndefined();
    expect(args.update).toBeUndefined();
    expect(args.onSuccessActivateScript).toBeNull();
    expect(args.onSuccessDeactivateScript).toBeNull();
    expect(text).toContain("2 Sieve scripts destroyed");
    expect(text).toContain("newsletters");
  });

  it("hands back the refusal the server filed against an id", async () => {
    const { context } = fakeTransport(
      [
        sieveGet(),
        {
          ...SET_OK,
          notDestroyed: {
            "sc-1": {
              type: "scriptIsActive",
              description: "Deactivate Sieve script before deletion.",
            },
          },
        },
      ],
      { blobs: scriptBlobs },
    );

    const { text } = await sieveWrite.run({ action: "delete", ids: ["sc-1"] }, context);

    expect(text).toContain("No Sieve script was destroyed");
    expect(text).toContain("filtering incoming mail");
  });

  it("says outright that nothing brings a destroyed script back", async () => {
    const { context } = fakeTransport([sieveGet()], { blobs: scriptBlobs });

    const summary = await sieveWrite.summarize({ action: "delete", ids: ["sc-1"] }, context);

    expect(summary).toContain("newsletters (sc-1)");
    expect(summary).toContain("no trash");
  });
});

describe("sieve_write, at the schema", () => {
  it("requires a name on every store, correction included", () => {
    // Without one, `sieve/set.rs:507-513` gives the script a random fifteen
    // character name, and a script nobody can find is one nobody can delete.
    expect(sieveWrite.inputSchema.safeParse({ action: "store", script: VALID }).success).toBe(
      false,
    );
    expect(
      sieveWrite.inputSchema.safeParse({ action: "store", name: "", script: VALID }).success,
    ).toBe(false);
    expect(
      sieveWrite.inputSchema.safeParse({ action: "store", name: "a", script: VALID }).success,
    ).toBe(true);
  });

  it("refuses a store with no text to store", () => {
    expect(sieveWrite.inputSchema.safeParse({ action: "store", name: "a" }).success).toBe(false);
  });

  it("makes each destructive action name what it acts on", () => {
    expect(sieveWrite.inputSchema.safeParse({ action: "activate" }).success).toBe(false);
    expect(sieveWrite.inputSchema.safeParse({ action: "activate", id: "sc-1" }).success).toBe(true);
    expect(sieveWrite.inputSchema.safeParse({ action: "delete" }).success).toBe(false);
    expect(sieveWrite.inputSchema.safeParse({ action: "delete", ids: ["sc-1"] }).success).toBe(
      true,
    );
  });

  it("asks nothing of a deactivation, which has one target and no way to name it", () => {
    expect(sieveWrite.inputSchema.safeParse({ action: "deactivate" }).success).toBe(true);
  });
});

describe("the two Sieve manifests under the same capability", () => {
  function registerWith(capabilities: string[]) {
    const registered: string[] = [];
    const report = compose({
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      } as unknown as McpServer,
      domains: [sieveDomain, sieveWritingDomain],
      session: { has: (uri: string) => capabilities.includes(uri) } as unknown as JmapSession,
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    return { registered, report };
  }

  it("registers reading and writing together when the capability is there", () => {
    const { registered, report } = registerWith([CAPABILITY_SIEVE]);

    expect(registered).toEqual(["sieve_scripts", "sieve_write"]);
    expect(report.skipped).toEqual([]);
  });

  it("drops both and names each one when it is not", () => {
    const { registered, report } = registerWith([CAPABILITY_MAIL]);

    expect(registered).toEqual([]);
    expect(report.skipped).toEqual([
      { domain: "sieve", missing: [CAPABILITY_SIEVE] },
      { domain: "sieve-writing", missing: [CAPABILITY_SIEVE] },
    ]);
  });
});

describe("sieve_write refusals from the server", () => {
  it("names the script already holding the name", () => {
    const explained = explainSetError({
      type: "alreadyExists",
      ...({ existingId: "sc-7" } as Record<string, unknown>),
    });

    expect(explained).toContain("sc-7");
    expect(explained).toContain("already there");
  });

  it("reads the wire codes and not the ones the RFC names", () => {
    // Stalwart serialises `invalidScript`; RFC 9661 calls it `invalidSieve`.
    expect(explainSetError({ type: "invalidScript" })).toContain("does not compile");
    expect(explainSetError({ type: "invalidSieve" })).toContain("invalidSieve");
  });

  it("says what to do about a quota and about an unusable property", () => {
    expect(explainSetError({ type: "overQuota" })).toContain("no room left");
    expect(explainSetError({ type: "invalidProperties" })).toContain("name longer than");
  });

  it("carries a server description through rather than swallowing it", () => {
    const explained = explainSetError({ type: "forbidden", description: "Not your account." });

    expect(explained).toContain("forbidden");
    expect(explained).toContain("Not your account.");
  });
});
