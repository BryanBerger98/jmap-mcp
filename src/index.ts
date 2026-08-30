#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config/load.js";
import { describeStartupFailure } from "./jmap/errors.js";
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

// A partial startup does not exist: without a session there is nothing to serve.
main().catch((error: unknown) => {
  console.error(`jmap-mcp: ${describeStartupFailure(error)}`);
  process.exit(1);
});
