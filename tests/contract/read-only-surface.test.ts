import type { McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/config/policy.js";
import { mailDomain } from "../../src/domains/mail/index.js";
import type { JmapClient } from "../../src/jmap/client.js";
import type { JmapSession } from "../../src/jmap/session.js";
import { CAPABILITY_MAIL, CAPABILITY_SUBMISSION } from "../../src/jmap/types/core.js";
import { compose } from "../../src/registry/compose.js";

/**
 * The invariant this file exists for: the mail domain exposes reads and nothing
 * else. It grows with each tool the domain gains, without being rewritten —
 * a tool that declares a write class fails the suite the day it is added.
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
      domains: [mailDomain],
      session: { has: (uri: string) => uri === CAPABILITY_MAIL } as unknown as JmapSession,
      client: {} as JmapClient,
      policy: DEFAULT_POLICY,
    });

    expect(mailDomain.requires).not.toContain(CAPABILITY_SUBMISSION);
    expect(report.skipped).toEqual([]);
    expect(registered).toEqual(mailDomain.tools.map((tool) => tool.name));
  });
});
