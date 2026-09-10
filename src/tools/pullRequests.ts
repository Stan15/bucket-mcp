import { z } from "zod";
import {
  CommentResolutionSchema,
  CommentSchema,
  CommitStatusSchema,
  DiffStatEntrySchema,
  MergeTaskStatusSchema,
  ParticipantSchema,
  PullRequest,
  PullRequestSchema,
  TaskSchema,
} from "../bitbucket/types.js";
import { BitbucketApiError, BitbucketClient } from "../bitbucket/client.js";
import { defineTool, ToolSpec, workspaceField } from "./index.js";
import { errorResult, okResult, resolveWorkspace, withErrorHandling } from "./toolHelpers.js";

const workspaceRepo = {
  ...workspaceField,
  repoSlug: z.string().describe("Repository slug, e.g. 'my-repo'"),
};

// Fields kept deliberately narrow (see bitbucket-api-contract.md §2 on `fields=`)
// - only what a PR-review workflow actually needs, not Bitbucket's full representation.
// draft/comment_count/task_count are cheap, high-signal additions confirmed
// present on the real pullrequest object via the live OpenAPI spec.
const PR_LIST_FIELDS =
  "next,values.id,values.title,values.state,values.draft,values.comment_count,values.task_count,values.author.display_name," +
  "values.source.branch.name,values.destination.branch.name,values.created_on,values.updated_on,values.links.html.href";
const PR_FULL_FIELDS =
  "id,title,description,state,draft,comment_count,task_count,author.display_name,source.branch.name,destination.branch.name," +
  "reviewers.display_name,participants.user.display_name,participants.approved,participants.state," +
  "created_on,updated_on,links.html.href";

function summarizePr(pr: PullRequest): string {
  const draft = pr.draft ? " [DRAFT]" : "";
  const counts = `${pr.comment_count ?? 0} comment(s), ${pr.task_count ?? 0} task(s)`;
  return `PR #${pr.id}: "${pr.title}"${draft} [${pr.state}] ${pr.source?.branch.name} -> ${pr.destination?.branch.name} (${counts})`;
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values, hasMore } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const pr = await bitbucket.get(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const pr = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const pr = await bitbucket.put(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    // Returns the caller's participant record, not the PR (confirmed via
    // the live spec) - surface the real state Bitbucket recorded rather
    // than just echoing back the intent.
    const participant = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/approve`,
      undefined,
      undefined,
      ParticipantSchema,
    );
    return okResult({ participant }, `Approved PR #${args.id} as ${participant.user?.display_name ?? "you"}.`);
  }),
});

const pullRequestUnapprove = defineTool({
  name: "bitbucket_pull_request_unapprove",
  description: "Remove your approval from a pull request.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    await bitbucket.delete(`/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/approve`);
    return okResult({ approved: false }, `Removed approval from PR #${args.id}.`);
  }),
});

const pullRequestRequestChanges = defineTool({
  name: "bitbucket_pull_request_request_changes",
  description: "Request changes on a pull request (blocking feedback, distinct from a decline).",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const participant = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/request-changes`,
      undefined,
      undefined,
      ParticipantSchema,
    );
    return okResult({ participant }, `Requested changes on PR #${args.id} as ${participant.user?.display_name ?? "you"}.`);
  }),
});

const pullRequestRemoveRequestChanges = defineTool({
  name: "bitbucket_pull_request_remove_request_changes",
  description: "Remove your own change request from a pull request.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    await bitbucket.delete(`/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/request-changes`);
    return okResult({ removed: true }, `Removed change request from PR #${args.id}.`);
  }),
});

const pullRequestDecline = defineTool({
  name: "bitbucket_pull_request_decline",
  description: "Decline (close without merging) a pull request. Irreversible via this tool.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const pr = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/decline`,
      undefined,
      undefined,
      PullRequestSchema,
    );
    return okResult({ pullRequest: pr }, `Declined ${summarizePr(pr)}`);
  }),
});

/**
 * How many times to poll a still-merging task before giving up and handing
 * the model a task ID to check later. 5 x 2s = 10s of extra wait in the
 * worst case - enough to absorb "just a bit slow" without making a plain
 * merge_commit tool call hang indefinitely.
 */
const MERGE_POLL_ATTEMPTS = 5;
const MERGE_POLL_DELAY_MS = 2000;

async function pollMergeTask(
  bitbucket: BitbucketClient,
  workspace: string,
  repoSlug: string,
  prId: number,
  taskId: string,
) {
  for (let attempt = 0; attempt < MERGE_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, MERGE_POLL_DELAY_MS));
    const status = await bitbucket.get(
      `/repositories/${workspace}/${repoSlug}/pullrequests/${prId}/merge/task-status/${taskId}`,
      undefined,
      MergeTaskStatusSchema,
    );
    if (status.task_status !== "PENDING") return status;
  }
  return undefined;
}

/**
 * Bitbucket's merge endpoint has THREE distinct response shapes depending
 * on how long the merge takes (confirmed against the live OpenAPI spec,
 * not assumed from sibling endpoints - see the commit history for why this
 * needed fixing):
 *  - 200: merge completed inline, body is the merged pull request.
 *  - 202: still merging: no JSON body, only a Location header pointing at
 *    the task-status endpoint to poll.
 *  - 555: timed out server-side; Bitbucket's own docs say this is safe to
 *    retry.
 *  - 409: couldn't merge because a ref changed underneath the request.
 * The original implementation only handled the 200 case, which happens to
 * be the common case, but would have thrown an unhandled parse error on a
 * slow merge and given a bare, unexplained error on 555/409.
 */
const pullRequestMerge = defineTool({
  name: "bitbucket_pull_request_merge",
  description:
    "Merge a pull request. Irreversible. If Bitbucket needs more time than usual, this waits briefly then returns " +
    "a task ID to check with bitbucket_pull_request_merge_status instead of failing.",
  inputSchema: {
    ...workspaceRepo,
    id: z.number().int(),
    strategy: z.enum(["merge_commit", "squash", "fast_forward"]).default("merge_commit"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const path = `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/merge`;

    try {
      const { body, response } = await bitbucket.postWithResponse<unknown>(path, { merge_strategy: args.strategy });

      if (response.status === 200) {
        const pr = PullRequestSchema.parse(body);
        return okResult({ pullRequest: pr }, `Merged ${summarizePr(pr)}`);
      }

      // 202: accepted, still merging. Task-status URL is the last path segment of Location.
      const location = response.headers.get("location");
      const taskId = location?.split("/").filter(Boolean).pop();
      if (!taskId) {
        return errorResult(
          new Error(`Merge of PR #${args.id} was accepted (202) but no task ID was found in the Location header.`),
        );
      }

      const settled = await pollMergeTask(bitbucket, workspace, args.repoSlug, args.id, taskId);
      if (settled?.task_status === "SUCCESS" && settled.merge_result) {
        return okResult({ pullRequest: settled.merge_result }, `Merged ${summarizePr(settled.merge_result)} (completed after a brief wait).`);
      }
      if (settled?.task_status === "FAILED") {
        return errorResult(new Error(`Merge of PR #${args.id} failed. Check the PR in Bitbucket for details.`));
      }
      return okResult(
        { taskId, status: "PENDING" as const },
        `Merge of PR #${args.id} is still in progress after a ${(MERGE_POLL_ATTEMPTS * MERGE_POLL_DELAY_MS) / 1000}s wait. ` +
          `Check again with bitbucket_pull_request_merge_status(taskId: "${taskId}").`,
      );
    } catch (error) {
      if (error instanceof BitbucketApiError && error.status === 555) {
        return errorResult(new Error(`Merge of PR #${args.id} timed out server-side. Bitbucket's docs say this is safe to retry.`));
      }
      if (error instanceof BitbucketApiError && error.status === 409) {
        return errorResult(
          new Error(`Could not merge PR #${args.id}: the source or destination ref changed during the attempt. Refresh the PR and retry.`),
        );
      }
      throw error;
    }
  }),
});

const pullRequestMergeStatus = defineTool({
  name: "bitbucket_pull_request_merge_status",
  description: "Check the status of a merge that bitbucket_pull_request_merge reported as still in progress.",
  inputSchema: { ...workspaceRepo, id: z.number().int(), taskId: z.string() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const status = await bitbucket.get(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/merge/task-status/${args.taskId}`,
      undefined,
      MergeTaskStatusSchema,
    );
    if (status.task_status === "SUCCESS" && status.merge_result) {
      return okResult({ pullRequest: status.merge_result }, `Merged ${summarizePr(status.merge_result)}`);
    }
    return okResult({ status: status.task_status }, `Merge task status: ${status.task_status}`);
  }),
});

const pullRequestDiffstat = defineTool({
  name: "bitbucket_pull_request_diffstat",
  description: "Get the per-file change summary (files touched, lines +/-) for a pull request. Cheapest way to see 'what changed' - prefer this over the full diff unless file contents are actually needed.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/diffstat`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const diff = await bitbucket.get<string>(`/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/diff`, {
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const comment = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/comments`,
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
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/comments`,
      { fields: "next,values.id,values.content.raw,values.user.display_name,values.inline.path,values.inline.to,values.deleted" },
      args.maxItems,
      CommentSchema,
    );
    const active = values.filter((c) => !c.deleted);
    const text = active.map((c) => `[${c.id}] ${c.user?.display_name ?? "?"}${c.inline ? ` (${c.inline.path}:${c.inline.to ?? ""})` : ""}: ${c.content.raw}`).join("\n---\n");
    return okResult({ comments: active }, text || "No comments.");
  }),
});

const pullRequestCommentResolve = defineTool({
  name: "bitbucket_pull_request_comment_resolve",
  description: "Mark a pull request comment thread as resolved.",
  inputSchema: { ...workspaceRepo, id: z.number().int(), commentId: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const resolution = await bitbucket.post(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/comments/${args.commentId}/resolve`,
      undefined,
      undefined,
      CommentResolutionSchema,
    );
    return okResult({ resolution }, `Resolved comment ${args.commentId} on PR #${args.id}.`);
  }),
});

const pullRequestCommentReopen = defineTool({
  name: "bitbucket_pull_request_comment_reopen",
  description: "Reopen a resolved pull request comment thread.",
  inputSchema: { ...workspaceRepo, id: z.number().int(), commentId: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    await bitbucket.delete(`/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/comments/${args.commentId}/resolve`);
    return okResult({ reopened: true }, `Reopened comment ${args.commentId} on PR #${args.id}.`);
  }),
});

const pullRequestListStatuses = defineTool({
  name: "bitbucket_pull_request_list_statuses",
  description: "List build/CI statuses on a pull request's current head commit - use to check whether a PR is safe to merge.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/statuses`,
      undefined,
      50,
      CommitStatusSchema,
    );
    const text = values.map((s) => `${s.state} ${s.key}${s.description ? ` - ${s.description}` : ""}`).join("\n");
    return okResult({ statuses: values }, text || "No statuses.");
  }),
});

const pullRequestTaskList = defineTool({
  name: "bitbucket_pull_request_task_list",
  description: "List a pull request's checklist tasks (what PullRequestSchema.task_count counts) - distinct from comments.",
  inputSchema: { ...workspaceRepo, id: z.number().int() },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const { values } = await bitbucket.paginate(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/tasks`,
      undefined,
      50,
      TaskSchema,
    );
    const text = values.map((t) => `[${t.id}] ${t.state}: ${t.content.raw}${t.creator?.display_name ? ` (${t.creator.display_name})` : ""}`).join("\n");
    return okResult({ tasks: values }, text || "No tasks.");
  }),
});

const pullRequestTaskResolve = defineTool({
  name: "bitbucket_pull_request_task_resolve",
  description: "Mark a pull request checklist task as resolved.",
  inputSchema: { ...workspaceRepo, id: z.number().int(), taskId: z.number().int() },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  requiredScope: "write:pullrequest:bitbucket",
  isWriteOrDestructive: true,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const task = await bitbucket.put(
      `/repositories/${workspace}/${args.repoSlug}/pullrequests/${args.id}/tasks/${args.taskId}`,
      { state: "RESOLVED" },
      undefined,
      TaskSchema,
    );
    return okResult({ task }, `Resolved task ${args.taskId} on PR #${args.id}.`);
  }),
});

export const pullRequestTools: ToolSpec[] = [
  pullRequestList,
  pullRequestGet,
  pullRequestCreate,
  pullRequestUpdate,
  pullRequestApprove,
  pullRequestUnapprove,
  pullRequestRequestChanges,
  pullRequestRemoveRequestChanges,
  pullRequestDecline,
  pullRequestMerge,
  pullRequestMergeStatus,
  pullRequestDiffstat,
  pullRequestDiff,
  pullRequestCommentCreate,
  pullRequestCommentList,
  pullRequestCommentResolve,
  pullRequestCommentReopen,
  pullRequestListStatuses,
  pullRequestTaskList,
  pullRequestTaskResolve,
];
