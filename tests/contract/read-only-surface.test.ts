import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { mailDomain, mailSendingDomain } from "../../src/domains/mail/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";

/**
 * The invariant this file exists for: the `mail` manifest exposes reads and
 * nothing else, so a server that advertises mail without submission can be
 * driven with no risk at all. It grows with each tool that manifest gains,
 * without being rewritten — a tool declaring a write class fails the suite the
 * day it is added there.
 *
 * Writing lives in `mailSendingDomain`, which this file holds to the opposite
 * assertion: none of its tools may reach a session that does not send.
 */

describe("mail domain surface", () => {
  it.each(mailDomain.tools.map((tool) => [tool.name, tool] as const))(
    "%s declares the read class only",
    (_name, tool) => {
      expect(tool.classes).toEqual(["read"]);
    },
  );

  it.each(mailDomain.tools.map((tool) => [tool.name, tool] as const))(
    "%s classifies any call as a read",
    (_name, tool) => {
      // Arbitrary arguments: no input may flip a read tool into a write.
      expect(tool.classify({ ids: ["x"], destroy: true, send: true })).toBe("read");
    },
  );

  it("registers its tools on a server that advertises mail without submission", () => {
    const registered: string[] = [];
    const server = {
      registerTool(name: string) {
        registered.push(name);
      },
    } as unknown as McpServer;

    const report = compose({
      server,
      domains: [mailDomain, mailSendingDomain],
      session: { has: (uri: string) => uri === CAPABILITY_MAIL } as unknown as JmapSession,
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(mailDomain.requires).not.toContain(CAPABILITY_SUBMISSION);
    expect(registered).toEqual(mailDomain.tools.map((tool) => tool.name));

    // The sending manifest is the only one skipped, and it is skipped whole.
    expect(report.skipped).toEqual([{ domain: "mail", missing: [CAPABILITY_SUBMISSION] }]);
    for (const tool of mailSendingDomain.tools) {
      expect(registered).not.toContain(tool.name);
    }
  });

  it("shares the mail_ prefix across both manifests, and names no tool twice", () => {
    const names = [...mailDomain.tools, ...mailSendingDomain.tools].map((tool) => tool.name);

    expect(names.every((name) => name.startsWith("mail_"))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });
});
