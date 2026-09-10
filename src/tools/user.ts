import { z } from "zod";
import { PullRequestSchema, UserSchema, WorkspaceAccessSchema, WorkspaceMembershipSchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec, workspaceField } from "./index.js";
import { okResult, resolveWorkspace, withErrorHandling } from "./toolHelpers.js";

const whoami = defineTool({
  name: "bitbucket_whoami",
  description: "Get the identity (display name, uuid) of the currently authenticated Bitbucket account.",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:user:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (_args, { bitbucket }) => {
    const user = await bitbucket.get("/user", undefined, UserSchema);
    return okResult({ user }, `${user.display_name}${user.uuid ? ` (${user.uuid})` : ""}`);
  }),
});

/**
 * The one tool that legitimately takes NO workspace at all - it's how the
 * model discovers what workspaces exist in the first place, which is the
 * prerequisite for every other tool's `workspace` argument (whether
 * defaulted or explicit).
 */
const workspaceList = defineTool({
  name: "bitbucket_workspace_list",
  description:
    "List every Bitbucket workspace the authenticated account can access. Use this to discover a workspace slug " +
    "before calling any other tool, or to find one other than the configured default.",
  inputSchema: { maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:workspace:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, { bitbucket }) => {
    const { values, hasMore } = await bitbucket.paginate("/user/workspaces", undefined, args.maxItems, WorkspaceAccessSchema);
    const text =
      values.map((w) => `${w.workspace.slug} - ${w.workspace.name}${w.administrator ? " (admin)" : ""}`).join("\n") +
      (hasMore ? "\n(more results available)" : "");
    return okResult({ workspaces: values.map((w) => w.workspace) }, text || "No workspaces found.");
  }),
});

const workspaceMemberList = defineTool({
  name: "bitbucket_workspace_member_list",
  description:
    "List members of a workspace, with their account uuid. Use this to resolve a teammate's name to the uuid " +
    "bitbucket_pull_request_create's `reviewers` argument requires (it does not accept plain names).",
  inputSchema: { ...workspaceField, maxItems: z.number().int().min(1).max(100).default(25) },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:workspace:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { values, hasMore } = await context.bitbucket.paginate(
      `/workspaces/${workspace}/members`,
      undefined,
      args.maxItems,
      WorkspaceMembershipSchema,
    );
    const text =
      values.map((m) => `${m.user.display_name}${m.user.uuid ? ` (${m.user.uuid})` : ""}`).join("\n") +
      (hasMore ? "\n(more results available)" : "");
    return okResult({ members: values.map((m) => m.user) }, text || "No members found.");
  }),
});

const pullRequestListByUser = defineTool({
  name: "bitbucket_pull_request_list_by_user",
  description: "List a user's pull requests across every repository in a workspace - use bitbucket_whoami first to list your own.",
  inputSchema: {
    ...workspaceField,
    selectedUser: z.string().describe("Account UUID (e.g. '{...}') of the user whose PRs to list"),
    state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).optional(),
    maxItems: z.number().int().min(1).max(100).default(25),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:pullrequest:bitbucket",
  isWriteOrDestructive: false,
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { values, hasMore } = await context.bitbucket.paginate(
      `/workspaces/${workspace}/pullrequests/${args.selectedUser}`,
      { state: args.state },
      args.maxItems,
      PullRequestSchema,
    );
    const text =
      values.map((pr) => `PR #${pr.id}: "${pr.title}" [${pr.state}]`).join("\n") + (hasMore ? "\n(more results available)" : "");
    return okResult({ pullRequests: values, hasMore }, text || "No pull requests found.");
  }),
});

export const userTools: ToolSpec[] = [whoami, workspaceList, workspaceMemberList, pullRequestListByUser];
