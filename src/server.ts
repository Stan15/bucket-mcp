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
import { sourceTools } from "./tools/source.js";
import { userTools } from "./tools/user.js";

const ALL_TOOLS: ToolSpec[] = [
  ...repositoryTools,
  ...pullRequestTools,
  ...commitTools,
  ...refTools,
  ...searchTools,
  ...sourceTools,
  ...userTools,
];

/**
 * Builds the MCP server with the tool set gated per the decided design:
 * - the operator's mode ceiling (readonly/draft/readwrite) filters which
 *   tools are registered at all.
 * - by default, every tool the mode allows is registered regardless of what
 *   the startup scope probe found the credential actually holds - a missing
 *   scope surfaces as a clear 403 on the real call instead of a silent gap
 *   in the tool list. See scopeProbe.ts's isToolAllowed for the (deliberately
 *   undocumented) flag that restores probe-based filtering.
 */
export async function createServer(
  config: Config,
  credentials: CredentialProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<McpServer> {
  const bitbucket = new BitbucketClient(credentials, fetchImpl);
  const context: RequestContext = { bitbucket, defaultWorkspace: config.defaultWorkspace };

  const probe = await probeGrantedScopes(bitbucket);

  const workspaceInstructions = config.defaultWorkspace
    ? `Default workspace is "${config.defaultWorkspace}" - omit \`workspace\` on any tool to use it, or pass one explicitly to target a different workspace (use bitbucket_workspace_list to discover options).`
    : "No default workspace is configured, so `workspace` is required on every call - use bitbucket_workspace_list to discover which workspaces are available.";

  const modeInstructions =
    config.mode === "draft"
      ? "Draft mode: PRs and comments/tasks you create are enforced non-live (a draft PR is visible to teammates but marked not-ready-for-review; a pending comment/task is invisible to everyone but you until the human submits their review in Bitbucket). No tool here can merge, approve, edit an existing PR, or otherwise publish anything - that step is deliberately left to a human, in Bitbucket's own UI."
      : config.mode === "readonly"
        ? "Read-only mode: no write or destructive tool of any kind is available."
        : "Full write access is enabled, including irreversible actions (merge, decline, delete). PRs and comments/tasks you create still default to draft/pending (not live) - pass draft:false / pending:false explicitly to make one live immediately.";

  const server = new McpServer(
    { name: "bucket-mcp", version: "0.1.0" },
    {
      instructions:
        "Bitbucket Cloud tools for code review and PR workflows. Diffs can be large - prefer the *_diffstat tools " +
        "before *_diff/*_diff to see what changed without pulling full file contents into context. " +
        `${workspaceInstructions} ${modeInstructions}`.trim(),
    },
  );

  let registeredCount = 0;
  for (const tool of ALL_TOOLS) {
    if (tool.onlyInModes && !tool.onlyInModes.includes(config.mode)) {
      continue;
    }
    if (!isToolAllowed(probe, tool.requiredScope, tool.writeLevel, config.mode, config.strictScopeFilter)) {
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
  console.error(`bucket-mcp: registered ${registeredCount} tools (${probeSummary}, mode=${config.mode})`);
  if (config.mode === "readwrite") {
    console.error("bucket-mcp: WARNING - full write access enabled, including merge/decline/delete. Set BITBUCKET_MCP_MODE=draft for a safer default.");
  }

  return server;
}
