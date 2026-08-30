import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_POLICY, type OperationClass } from "../../src/config/policy.js";
import { JmapSession } from "../../src/jmap/session.js";
import type { Session } from "../../src/jmap/types/core.js";
import { selectTools } from "../../src/registry/compose.js";
import { defineTool } from "../../src/registry/define-tool.js";
import { buildInstructions, READ_ONLY_PROMISE } from "../../src/registry/instructions.js";
import { defineDomain } from "../../src/registry/manifest.js";

const raw = JSON.parse(
  readFileSync(new URL("../fixtures/session.json", import.meta.url), "utf8"),
) as Session;

const session = new JmapSession(raw, "acc-1");

const readOnly = new Set<OperationClass>(["read"]);

describe("buildInstructions", () => {
  it("names the account and the login it was opened with", () => {
    const text = buildInstructions(session, readOnly);

    expect(text).toContain('"Bryan Berger"');
    expect(text).toContain("bryan@example.com");
    expect(text).toContain("personal");
  });

  it("lists every advertised domain and silently drops an unknown URI", () => {
    const text = buildInstructions(session, readOnly);

    expect(text).toContain("Mail");
    expect(text).toContain("Sending");
    expect(text).not.toContain("urn:stalwart:jmap");
    expect(text).not.toContain("urn:ietf:params:jmap:core");
  });

  it("promises innocuousness when every exposed class is a read", () => {
    expect(buildInstructions(session, readOnly)).toContain(READ_ONLY_PROMISE);
  });

  it("withdraws the promise as soon as one exposed class writes", () => {
    const text = buildInstructions(session, new Set<OperationClass>(["read", "destroy"]));

    expect(text).not.toContain(READ_ONLY_PROMISE);
    expect(text).toContain("not read-only");
    expect(text).toContain("move or delete data");
  });

  it("promises nothing when the crossing exposed no tool at all", () => {
    const text = buildInstructions(session, new Set<OperationClass>());

    expect(text).not.toContain(READ_ONLY_PROMISE);
    expect(text).toContain("No tool is exposed");
  });

  it("stays short enough to pay for on every initialization", () => {
    expect(buildInstructions(session, readOnly).length).toBeLessThan(1000);
  });

  it("says so rather than failing when no advertised URI is recognised", () => {
    const unknownOnly = new JmapSession(
      { ...raw, capabilities: { "urn:stalwart:jmap": {} } },
      "acc-1",
    );

    expect(buildInstructions(unknownOnly, readOnly)).toContain("no recognised domain");
  });
});

/**
 * The invariant the fix exists for: the scope sentence follows the registered
 * surface. It is derived from the same crossing `compose` performs, so a domain
 * that declares a write class rewrites the text without anyone editing it.
 */
describe("scope sentence against a composed surface", () => {
  function classesOf(classes: readonly [OperationClass, ...OperationClass[]]) {
    const tool = defineTool({
      name: "mail_x",
      title: "X",
      description: "",
      inputSchema: z.object({}),
      classes,
      classify: () => classes[0],
      summarize: () => "",
      run: async () => ({ text: "" }),
    });

    return selectTools(
      [defineDomain({ name: "mail", requires: [], tools: [tool] })],
      { has: () => true } as unknown as JmapSession,
      DEFAULT_POLICY,
    ).classes;
  }

  it("keeps the promise for a domain exposing reads only", () => {
    expect(buildInstructions(session, classesOf(["read"]))).toContain(READ_ONLY_PROMISE);
  });

  it("loses the promise the day a domain exposes a write", () => {
    expect(buildInstructions(session, classesOf(["read", "send"]))).not.toContain(
      READ_ONLY_PROMISE,
    );
  });
});

describe("JmapSession.account", () => {
  it("resolves the selected account", () => {
    expect(session.account.name).toBe("Bryan Berger");
  });

  it("throws when the account id is not in the session", () => {
    expect(() => new JmapSession(raw, "acc-missing").account).toThrow(/acc-missing/);
  });
});
