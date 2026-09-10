import { z } from "zod";
import { Repository, RepositorySchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec } from "./index.js";
import { okResult, withErrorHandling } from "./toolHelpers.js";

const REPO_FIELDS = "values.uuid,values.name,values.full_name,values.description,values.is_private,values.mainbranch.name,values.links.html.href,next";
const REPO_FULL_FIELDS = "uuid,name,full_name,description,is_private,mainbranch.name,links.html.href";

function summarizeRepo(repo: Repository): string {
  return `${repo.full_name}${repo.description ? ` - ${repo.description}` : ""} (main: ${repo.mainbranch?.name ?? "?"})`;
}

const repositoryList = defineTool({
  name: "bitbucket_repository_list",
  description: "List repositories in a workspace.",
  inputSchema: {
    workspace: z.string(),
    query: z.string().optional().describe("BBQL filter, e.g. 'name ~ \"api\"'"),
    maxItems: z.number().int().min(1).max(100).default(25),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate(
      `/repositories/${args.workspace}`,
      { q: args.query, fields: REPO_FIELDS, pagelen: Math.min(args.maxItems, 50) },
      args.maxItems,
      RepositorySchema,
    );
    const text = values.map(summarizeRepo).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ repositories: values, hasMore }, text || "No repositories found.");
  }),
});

const repositoryGet = defineTool({
  name: "bitbucket_repository_get",
  description: "Get details of one repository.",
  inputSchema: { workspace: z.string(), repoSlug: z.string() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const repo = await bitbucket.get(`/repositories/${args.workspace}/${args.repoSlug}`, { fields: REPO_FULL_FIELDS }, RepositorySchema);
    return okResult({ repository: repo }, summarizeRepo(repo));
  }),
});

export const repositoryTools: ToolSpec[] = [repositoryList, repositoryGet];
