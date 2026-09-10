import { z } from "zod";
import { Commit, CommitStatus } from "../bitbucket/types.js";
import { defineTool, ToolSpec } from "./index.js";
import { okResult, withErrorHandling } from "./toolHelpers.js";

const workspaceRepo = { workspace: z.string(), repoSlug: z.string() };

const COMMIT_LIST_FIELDS = "next,values.hash,values.message,values.date,values.author.raw,values.links.html.href";
const COMMIT_FULL_FIELDS = "hash,message,date,author.raw,links.html.href";

function summarizeCommit(c: Commit): string {
  return `${c.hash.slice(0, 12)} ${c.message.split("\n")[0]} (${c.author?.raw ?? "?"}, ${c.date})`;
}

const commitList = defineTool({
  name: "bitbucket_commit_list",
  description: "List commits on a branch/ref.",
  inputSchema: { ...workspaceRepo, revision: z.string().optional().describe("Branch, tag, or commit to list from"), maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const path = args.revision
      ? `/repositories/${args.workspace}/${args.repoSlug}/commits/${args.revision}`
      : `/repositories/${args.workspace}/${args.repoSlug}/commits`;
    const { values, hasMore } = await bitbucket.paginate<Commit>(path, { fields: COMMIT_LIST_FIELDS }, args.maxItems);
    const text = values.map(summarizeCommit).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ commits: values, hasMore }, text || "No commits found.");
  }),
});

const commitGet = defineTool({
  name: "bitbucket_commit_get",
  description: "Get one commit's details.",
  inputSchema: { ...workspaceRepo, commit: z.string() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const c = await bitbucket.get<Commit>(`/repositories/${args.workspace}/${args.repoSlug}/commit/${args.commit}`, { fields: COMMIT_FULL_FIELDS });
    return okResult({ commit: c }, `${summarizeCommit(c)}\n\n${c.message}`);
  }),
});

const commitDiffstat = defineTool({
  name: "bitbucket_commit_diffstat",
  description: "Get the per-file change summary for a commit or commit range (e.g. 'base..head'). Prefer over the full diff unless file contents are actually needed.",
  inputSchema: { ...workspaceRepo, spec: z.string().describe("A commit hash, or 'base..head' range") },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values } = await bitbucket.paginate<{ status: string; lines_added?: number; lines_removed?: number; old?: { path: string }; new?: { path: string } }>(
      `/repositories/${args.workspace}/${args.repoSlug}/diffstat/${args.spec}`,
      undefined,
      200,
    );
    const text = values.map((d) => `${d.status} ${d.new?.path ?? d.old?.path} (+${d.lines_added ?? 0}/-${d.lines_removed ?? 0})`).join("\n");
    return okResult({ files: values }, text || "No changes.");
  }),
});

const commitDiff = defineTool({
  name: "bitbucket_commit_diff",
  description: "Get the full unified diff for a commit or commit range, optionally scoped to one file. Prefer diffstat first.",
  inputSchema: { ...workspaceRepo, spec: z.string(), path: z.string().optional() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const diff = await bitbucket.get<string>(`/repositories/${args.workspace}/${args.repoSlug}/diff/${args.spec}`, { path: args.path });
    return okResult({ diff }, diff);
  }),
});

const commitListStatuses = defineTool({
  name: "bitbucket_commit_list_statuses",
  description: "List build/CI statuses attached to a commit.",
  inputSchema: { ...workspaceRepo, commit: z.string() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values } = await bitbucket.paginate<CommitStatus>(`/repositories/${args.workspace}/${args.repoSlug}/commit/${args.commit}/statuses`, undefined, 50);
    const text = values.map((s) => `${s.state} ${s.key}${s.description ? ` - ${s.description}` : ""}`).join("\n");
    return okResult({ statuses: values }, text || "No statuses.");
  }),
});

export const commitTools: ToolSpec[] = [commitList, commitGet, commitDiffstat, commitDiff, commitListStatuses];
