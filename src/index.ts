#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { StaticTokenCredentialProvider } from "./credentials.js";
import { createServer } from "./server.js";

// Without these, a bug anywhere in the process (not just inside a tool
// handler, which withErrorHandling already covers) crashes silently with
// Node's default stack dump instead of a message anyone would recognize as
// coming from this server. Log clearly, then exit - continuing after either
// of these means the process is in an unknown state, so staying alive isn't
// actually safer than a clean restart.
process.on("unhandledRejection", (reason) => {
  console.error("bucket-mcp: unhandled rejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (error) => {
  console.error("bucket-mcp: uncaught exception:", error);
  process.exit(1);
});

async function main() {
  const config = loadConfig();
  // v1 credential (personal scoped API token). Swap this line for an OAuth
  // CredentialProvider implementation later - nothing else in the codebase
  // needs to change (see credentials.ts).
  const credentials = new StaticTokenCredentialProvider(config.apiToken);

  const server = await createServer(config, credentials);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("bucket-mcp failed to start:", error);
  process.exit(1);
});