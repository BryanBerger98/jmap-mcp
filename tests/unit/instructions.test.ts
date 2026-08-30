import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JmapSession } from "../../src/jmap/session.js";
import type { Session } from "../../src/jmap/types/core.js";
import { buildInstructions } from "../../src/registry/instructions.js";

const raw = JSON.parse(
  readFileSync(new URL("../fixtures/session.json", import.meta.url), "utf8"),
) as Session;

const session = new JmapSession(raw, "acc-1");

describe("buildInstructions", () => {
  it("names the account and the login it was opened with", () => {
    const text = buildInstructions(session);

    expect(text).toContain('"Bryan Berger"');
    expect(text).toContain("bryan@example.com");
    expect(text).toContain("personal");
  });

  it("lists every advertised domain and silently drops an unknown URI", () => {
    const text = buildInstructions(session);

    expect(text).toContain("Mail");
    expect(text).toContain("Sending");
    expect(text).not.toContain("urn:stalwart:jmap");
    expect(text).not.toContain("urn:ietf:params:jmap:core");
  });

  it("states the read-only, single-account scope", () => {
    const text = buildInstructions(session);

    expect(text).toMatch(/reads/);
    expect(text).toMatch(/deletes/);
  });

  it("stays short enough to pay for on every initialization", () => {
    expect(buildInstructions(session).length).toBeLessThan(1000);
  });

  it("says so rather than failing when no advertised URI is recognised", () => {
    const unknownOnly = new JmapSession(
      { ...raw, capabilities: { "urn:stalwart:jmap": {} } },
      "acc-1",
    );

    expect(buildInstructions(unknownOnly)).toContain("no recognised domain");
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
