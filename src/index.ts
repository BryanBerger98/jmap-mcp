#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config/load.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const { server, report } = await buildServer(config);

  // stdout carries the JSON-RPC stream; anything diagnostic goes to stderr.
  console.error(
    `jmap-mcp: ${report.registered.length} tools registered, ` +
      `${report.skipped.length} domains skipped, ${report.denied.length} tools denied by policy.`,
  );

  // The factory is called per connection; the composed server is already built,
  // so both protocol eras are served by the same instance.
  serveStdio(() => server, {
    onerror: (error) => console.error(`jmap-mcp: ${error.message}`),
  });
}

main().catch((error: unknown) => {
  console.error(`jmap-mcp: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
