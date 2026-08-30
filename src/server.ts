import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config/schema.js";
import { ALL_DOMAINS } from "./domains/index.js";
import { JmapClient } from "./jmap/client.js";
import { discoverSession } from "./jmap/session.js";
import { type ComposeReport, compose, selectTools } from "./registry/compose.js";
import { buildInstructions } from "./registry/instructions.js";

export const SERVER_NAME = "jmap-mcp";
export const SERVER_VERSION = "0.1.0";

/**
 * Builds a fully composed server. Discovery runs first because the registry
 * needs the session's capabilities to decide which tools exist at all.
 */
export async function buildServer(
  config: Config,
): Promise<{ server: McpServer; report: ComposeReport }> {
  const session = await discoverSession(config.sessionUrl, config.bearerToken, config.accountId);

  const client = new JmapClient({
    apiUrl: session.apiUrl,
    bearerToken: config.bearerToken,
  });

  // The crossing is resolved before the server exists: instructions ride the
  // initialization response, which is built by the constructor, and they must
  // describe the surface `compose` is about to register.
  const selection = selectTools(ALL_DOMAINS, session, config.policy);

  // Instructions ride the initialization response, so the client learns which
  // mailbox it is on without listing or calling a tool.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: buildInstructions(session, selection.classes),
    },
  );

  const report = compose({
    server,
    domains: ALL_DOMAINS,
    session,
    client,
    policy: config.policy,
  });

  return { server, report };
}
