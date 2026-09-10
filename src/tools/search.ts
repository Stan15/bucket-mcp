import { z } from "zod";
import { CodeSearchResultSchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec, workspaceField } from "./index.js";
import { okResult, resolveWorkspace, withErrorHandling } from "./toolHelpers.js";

const codeSearch = defineTool({
  name: "bitbucket_code_search",
  description: "Search code across a workspace's repositories.",
  inputSchema: {
    ...workspaceField,
    searchQuery: z.string().describe("Search terms, e.g. 'function foo repo:my-repo'"),
    maxItems: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  requiredScope: "read:repository:bitbucket",
  writeLevel: "read",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values, hasMore } = await bitbucket.paginate(
      `/workspaces/${workspace}/search/code`,
      { search_query: args.searchQuery },
      args.maxItems,
      CodeSearchResultSchema,
    );
    const text =
      values
        .map((r) => {
          const lines = r.content_matches.flatMap((m) => m.lines.map((l) => `  ${l.line}: ${l.segments.map((s) => s.text).join("")}`));
          return `${r.file.path}\n${lines.join("\n")}`;
        })
        .join("\n\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ results: values, hasMore }, text || "No matches found.");
  }),
});

export const searchTools: ToolSpec[] = [codeSearch];
