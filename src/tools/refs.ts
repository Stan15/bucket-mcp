import { z } from "zod";
import { Branch, Tag } from "../bitbucket/types.js";
import { defineTool, ToolSpec } from "./index.js";
import { okResult, withErrorHandling } from "./toolHelpers.js";

const workspaceRepo = { workspace: z.string(), repoSlug: z.string() };
const REF_LIST_FIELDS = "next,values.name,values.target.hash,values.target.date";

const branchList = defineTool({
  name: "bitbucket_branch_list",
  description: "List branches in a repository.",
  inputSchema: { ...workspaceRepo, query: z.string().optional().describe("BBQL filter"), maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate<Branch>(`/repositories/${args.workspace}/${args.repoSlug}/refs/branches`, { q: args.query, fields: REF_LIST_FIELDS }, args.maxItems);
    const text = values.map((b) => `${b.name} @ ${b.target?.hash.slice(0, 12)}`).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ branches: values, hasMore }, text || "No branches found.");
  }),
});

const branchCreate = defineTool({
  name: "bitbucket_branch_create",
  description: "Create a new branch from a target commit/branch.",
  inputSchema: { ...workspaceRepo, name: z.string(), target: z.string().describe("Commit hash or branch name to branch from") },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  requiredScope: "write:repository:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const branch = await bitbucket.post<Branch>(`/repositories/${args.workspace}/${args.repoSlug}/refs/branches`, {
      name: args.name,
      target: { hash: args.target },
    });
    return okResult({ branch }, `Created branch ${branch.name}.`);
  }),
});

const branchDelete = defineTool({
  name: "bitbucket_branch_delete",
  description: "Delete a branch. Irreversible.",
  inputSchema: { ...workspaceRepo, name: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  requiredScope: "write:repository:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    await bitbucket.delete(`/repositories/${args.workspace}/${args.repoSlug}/refs/branches/${encodeURIComponent(args.name)}`);
    return okResult({ deleted: true }, `Deleted branch ${args.name}.`);
  }),
});

const tagList = defineTool({
  name: "bitbucket_tag_list",
  description: "List tags in a repository.",
  inputSchema: { ...workspaceRepo, maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate<Tag>(`/repositories/${args.workspace}/${args.repoSlug}/refs/tags`, { fields: REF_LIST_FIELDS }, args.maxItems);
    const text = values.map((t) => `${t.name} @ ${t.target?.hash.slice(0, 12)}`).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ tags: values, hasMore }, text || "No tags found.");
  }),
});

export const refTools: ToolSpec[] = [branchList, branchCreate, branchDelete, tagList];
