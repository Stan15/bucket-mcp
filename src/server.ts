import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Config } from "./config.js";
import { CredentialProvider } from "./credentials.js";
import { BitbucketClient } from "./bitbucket/client.js";
import { probeGrantedScopes, isToolAllowed } from "./scopeProbe.js";
import { RequestContext } from "./context.js";
import { ToolSpec } from "./tools/index.js";
import { repositoryTools } from "./tools/repositories.js";
import { pullRequestTools } from "./tools/pullRequests.js";
import { commitTools } from "./tools/commits.js";
import { refTools } from "./tools/refs.js";
import { searchTools } from "./tools/search.js";

const ALL_TOOLS: ToolSpec[] = [...repositoryTools, ...pullRequestTools, ...commitTools, ...refTools, ...searchTools];

/**
 * Builds the MCP server with the tool set gated per the decided design:
 * - startup scope probe (option C) filters by what the credential actually
 *   holds, failing open (option A: register everything) if the probe is
 *   inconclusive - see scopeProbe.ts.
 * - the operator's readonly flag (option B) is an independent override
 *   layered on top, applied regardless of what the probe found.
 */
export async function createServer(config: Config, credentials: CredentialProvider): Promise<McpServer> {
  const bitbucket = new BitbucketClient(credentials);
  const context: RequestContext = { bitbucket };

  const probe = await probeGrantedScopes(bitbucket);

  const server = new McpServer(
    { name: "bitbucket-mcp", version: "0.1.0" },
    {
      instructions:
        "Bitbucket Cloud tools for code review and PR workflows. Diffs can be large - prefer the *_diffstat tools " +
        "before *_diff/*_diff to see what changed without pulling full file contents into context.",
    },
  );

  let registeredCount = 0;
  for (const tool of ALL_TOOLS) {
    if (!isToolAllowed(probe, tool.requiredScope, tool.isWriteOrDestructive, config.readOnly)) {
      continue;
    }
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      (args) => tool.handler(args, context),
    );
    registeredCount++;
  }

  const probeSummary =
    probe.kind === "known"
      ? `${probe.scopes.size} granted scope(s) detected`
      : "scope probe inconclusive, failed open";
  console.error(
    `bitbucket-mcp: registered ${registeredCount}/${ALL_TOOLS.length} tools (${probeSummary}${config.readOnly ? ", read-only mode" : ""})`,
  );

  return server;
}
