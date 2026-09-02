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
