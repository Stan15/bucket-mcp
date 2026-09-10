import { z } from "zod";
import { CodeSearchResult } from "../bitbucket/types.js";
import { defineTool, ToolSpec } from "./index.js";
import { okResult, withErrorHandling } from "./toolHelpers.js";

const codeSearch = defineTool({
  name: "bitbucket_code_search",
  description: "Search code across a workspace's repositories.",
  inputSchema: {
    workspace: z.string(),
    searchQuery: z.string().describe("Search terms, e.g. 'function foo repo:my-repo'"),
    maxItems: z.number().int().min(1).max(50).default(10),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate<CodeSearchResult>(
      `/workspaces/${args.workspace}/search/code`,
      { search_query: args.searchQuery },
      args.maxItems,
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
