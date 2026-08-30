import { McpServer } from "@modelcontextprotocol/server";
import type { Config } from "./config/schema.js";
import { ALL_DOMAINS } from "./domains/index.js";
import { JmapClient } from "./jmap/client.js";
import { discoverSession } from "./jmap/session.js";
import { type ComposeReport, compose } from "./registry/compose.js";

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

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
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
