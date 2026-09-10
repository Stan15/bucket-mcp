import { z } from "zod";
import { CommentSchema, DiffStatEntrySchema, PullRequest, PullRequestSchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec } from "./index.js";
import { okResult, withErrorHandling } from "./toolHelpers.js";

const workspaceRepo = {
  workspace: z.string().describe("Workspace slug, e.g. 'my-team'"),
  repoSlug: z.string().describe("Repository slug, e.g. 'my-repo'"),
};

// Fields kept deliberately narrow (see bitbucket-api-contract.md §2 on `fields=`)
// - only what a PR-review workflow actually needs, not Bitbucket's full representation.
const PR_LIST_FIELDS =
  "next,values.id,values.title,values.state,values.author.display_name," +
  "values.source.branch.name,values.destination.branch.name,values.created_on,values.updated_on,values.links.html.href";
const PR_FULL_FIELDS =
  "id,title,description,state,author.display_name,source.branch.name,destination.branch.name," +
  "reviewers.display_name,participants.user.display_name,participants.approved,participants.state," +
  "created_on,updated_on,links.html.href";

function summarizePr(pr: PullRequest): string {
  return `PR #${pr.id}: "${pr.title}" [${pr.state}] ${pr.source?.branch.name} -> ${pr.destination?.branch.name}`;
}

const pullRequestList = defineTool({
  name: "bitbucket_pull_request_list",
  description: "List pull requests in a repository, optionally filtered by state.",
  inputSchema: {
    ...workspaceRepo,
    state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
    maxItems: z.number().int().min(1).max(100).default(25),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests`,
      { state: args.state, fields: PR_LIST_FIELDS, pagelen: Math.min(args.maxItems, 50) },
      args.maxItems,
      PullRequestSchema,
    );
    const text =
      values.map(summarizePr).join("\n") + (hasMore ? "\n(more results available - narrow with `state` or raise maxItems)" : "");
    return okResult({ pullRequests: values, hasMore }, text || "No pull requests found.");
  }),
});

const pullRequestGet = defineTool({
  name: "bitbucket_pull_request_get",
  description: "Get full details of one pull request.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const pr = await bitbucket.get(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}`,
      { fields: PR_FULL_FIELDS },
      PullRequestSchema,
    );
    return okResult({ pullRequest: pr }, `${summarizePr(pr)}\n\n${pr.description ?? "(no description)"}`);
  }),
});

const pullRequestCreate = defineTool({
  name: "bitbucket_pull_request_create",
  description: "Create a new pull request.",
  inputSchema: {
    ...workspaceRepo,
    title: z.string(),
    sourceBranch: z.string(),
    destinationBranch: z.string().optional().describe("Defaults to the repository's main branch"),
    description: z.string().optional(),
    reviewers: z.array(z.string()).optional().describe("Reviewer account UUIDs or nicknames"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const pr = await bitbucket.post(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests`,
      {
        title: args.title,
        description: args.description,
        source: { branch: { name: args.sourceBranch } },
        destination: args.destinationBranch ? { branch: { name: args.destinationBranch } } : undefined,
        reviewers: args.reviewers?.map((uuid) => ({ uuid })),
      },
      undefined,
      PullRequestSchema,
    );
    return okResult({ pullRequest: pr }, `Created ${summarizePr(pr)}\n${pr.links?.html?.href ?? ""}`);
  }),
});

const pullRequestUpdate = defineTool({
  name: "bitbucket_pull_request_update",
  description: "Update a pull request's title, description, or destination branch.",
  inputSchema: {
    ...workspaceRepo,
    id: z.number().int(),
    title: z.string().optional(),
    description: z.string().optional(),
    destinationBranch: z.string().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const pr = await bitbucket.put(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}`,
      {
        title: args.title,
        description: args.description,
        destination: args.destinationBranch ? { branch: { name: args.destinationBranch } } : undefined,
      },
      undefined,
      PullRequestSchema,
    );
    return okResult({ pullRequest: pr }, `Updated ${summarizePr(pr)}`);
  }),
});

const pullRequestApprove = defineTool({
  name: "bitbucket_pull_request_approve",
  description: "Approve a pull request as the authenticated user.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    await bitbucket.post(`/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/approve`);
    return okResult({ approved: true }, `Approved PR #${args.id}.`);
  }),
});

const pullRequestUnapprove = defineTool({
  name: "bitbucket_pull_request_unapprove",
  description: "Remove your approval from a pull request.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    await bitbucket.delete(`/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/approve`);
    return okResult({ approved: false }, `Removed approval from PR #${args.id}.`);
  }),
});

const pullRequestDecline = defineTool({
  name: "bitbucket_pull_request_decline",
  description: "Decline (close without merging) a pull request. Irreversible via this tool.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const pr = await bitbucket.post(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/decline`,
      undefined,
      undefined,
      PullRequestSchema,
    );
    return okResult({ pullRequest: pr }, `Declined ${summarizePr(pr)}`);
  }),
});

const pullRequestMerge = defineTool({
  name: "bitbucket_pull_request_merge",
  description: "Merge a pull request. Irreversible.",
  inputSchema: {
    ...workspaceRepo,
    id: z.number().int(),
    strategy: z.enum(["merge_commit", "squash", "fast_forward"]).default("merge_commit"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const result = await bitbucket.post(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/merge`,
      { merge_strategy: args.strategy },
      undefined,
      PullRequestSchema,
    );
    return okResult({ pullRequest: result }, `Merged PR #${args.id} using ${args.strategy}.`);
  }),
});

const pullRequestDiffstat = defineTool({
  name: "bitbucket_pull_request_diffstat",
  description: "Get the per-file change summary (files touched, lines +/-) for a pull request. Cheapest way to see 'what changed' - prefer this over the full diff unless file contents are actually needed.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values } = await bitbucket.paginate(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/diffstat`,
      undefined,
      200,
      DiffStatEntrySchema,
    );
    const text = values
      .map((d) => `${d.status} ${d.new?.path ?? d.old?.path} (+${d.lines_added ?? 0}/-${d.lines_removed ?? 0})`)
      .join("\n");
    return okResult({ files: values }, text || "No changes.");
  }),
});

const pullRequestDiff = defineTool({
  name: "bitbucket_pull_request_diff",
  description: "Get the full unified diff for a pull request, optionally scoped to one file. Prefer diffstat first; use this only when file contents are actually needed.",
  inputSchema: {
    ...workspaceRepo,
    id: z.number().int(),
    path: z.string().optional().describe("Scope the diff to one file path"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const diff = await bitbucket.get<string>(`/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/diff`, {
      path: args.path,
    });
    return okResult({ diff }, diff);
  }),
});

const pullRequestCommentCreate = defineTool({
  name: "bitbucket_pull_request_comment_create",
  description: "Add a comment to a pull request, optionally anchored to a specific file/line.",
  inputSchema: {
    ...workspaceRepo,
    id: z.number().int(),
    body: z.string(),
    inlinePath: z.string().optional(),
    inlineLine: z.number().int().optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const comment = await bitbucket.post(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/comments`,
      {
        content: { raw: args.body },
        inline: args.inlinePath ? { path: args.inlinePath, to: args.inlineLine } : undefined,
      },
      undefined,
      CommentSchema,
    );
    return okResult({ comment }, `Comment added to PR #${args.id}.`);
  }),
});

const pullRequestCommentList = defineTool({
  name: "bitbucket_pull_request_comment_list",
  description: "List comments on a pull request.",
  inputSchema: { ...workspaceRepo, id: z.number().int(), maxItems: z.number().int().min(1).max(100).default(50) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values } = await bitbucket.paginate(
      `/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.id}/comments`,
      { fields: "next,values.id,values.content.raw,values.user.display_name,values.inline.path,values.inline.to,values.deleted" },
      args.maxItems,
      CommentSchema,
    );
    const active = values.filter((c) => !c.deleted);
    const text = active.map((c) => `[${c.id}] ${c.user?.display_name ?? "?"}${c.inline ? ` (${c.inline.path}:${c.inline.to ?? ""})` : ""}: ${c.content.raw}`).join("\n---\n");
    return okResult({ comments: active }, text || "No comments.");
  }),
});

export const pullRequestTools: ToolSpec[] = [
  pullRequestList,
  pullRequestGet,
  pullRequestCreate,
  pullRequestUpdate,
  pullRequestApprove,
  pullRequestUnapprove,
  pullRequestDecline,
  pullRequestMerge,
  pullRequestDiffstat,
  pullRequestDiff,
  pullRequestCommentCreate,
  pullRequestCommentList,
];
