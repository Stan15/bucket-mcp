#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { StaticTokenCredentialProvider } from "./credentials.js";
import { createServer } from "./server.js";

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
  console.error("bitbucket-mcp failed to start:", error);
  process.exit(1);
});
