import { z } from "zod";
import { BranchSchema, TagSchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec, workspaceField } from "./index.js";
import { okResult, resolveWorkspace, withErrorHandling } from "./toolHelpers.js";

const workspaceRepo = { ...workspaceField, repoSlug: z.string() };
const REF_LIST_FIELDS = "next,values.name,values.target.hash,values.target.date";

const branchList = defineTool({
  name: "bitbucket_branch_list",
  description: "List branches in a repository.",
  inputSchema: { ...workspaceRepo, query: z.string().optional().describe("BBQL filter"), maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  writeLevel: "read",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values, hasMore } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/refs/branches`,
      { q: args.query, fields: REF_LIST_FIELDS },
      args.maxItems,
      BranchSchema,
    );
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
  writeLevel: "write",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const branch = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/refs/branches`,
      { name: args.name, target: { hash: args.target } },
      undefined,
      BranchSchema,
    );
    return okResult({ branch }, `Created branch ${branch.name}.`);
  }),
});

const branchDelete = defineTool({
  name: "bitbucket_branch_delete",
  description: "Delete a branch. Irreversible.",
  inputSchema: { ...workspaceRepo, name: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  requiredScope: "write:repository:bitbucket",
  writeLevel: "write",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    await bitbucket.delete(`/repositories/${workspace}/${args.repoSlug}/refs/branches/${encodeURIComponent(args.name)}`);
    return okResult({ deleted: true }, `Deleted branch ${args.name}.`);
  }),
});

const tagList = defineTool({
  name: "bitbucket_tag_list",
  description: "List tags in a repository.",
  inputSchema: { ...workspaceRepo, maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  writeLevel: "read",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values, hasMore } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/refs/tags`,
      { fields: REF_LIST_FIELDS },
      args.maxItems,
      TagSchema,
    );
    const text = values.map((t) => `${t.name} @ ${t.target?.hash.slice(0, 12)}`).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ tags: values, hasMore }, text || "No tags found.");
  }),
});

export const refTools: ToolSpec[] = [branchList, branchCreate, branchDelete, tagList];
