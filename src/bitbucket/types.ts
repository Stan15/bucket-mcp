import { z } from "zod";

/**
 * Response shapes as Zod schemas rather than plain interfaces - lets every
 * tool handler both get a compile-time type (via z.infer, used the same way
 * a plain interface would be) and optionally runtime-validate what Bitbucket
 * actually returned (via schema.parse(), see bitbucket/client.ts's `schema`
 * option). None of these are passed to registerTool's outputSchema - they
 * never reach the wire, so they cost nothing in tokens (see
 * mcp-best-practices.md's outputSchema discussion for why that was dropped).
 *
 * Deliberately narrow - only the fields tools actually request via `fields=`.
 */

export const WorkspaceSchema = z.object({
  uuid: z.string(),
  // Confirmed live: at least one real workspace in a real /user/workspaces
  // response can be missing name entirely - slug is the fallback display
  // identifier wherever this is shown to a person.
  name: z.string().optional(),
  slug: z.string(),
  is_private: z.boolean().optional(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** What GET /user/workspaces actually returns per-item: access info wrapping the workspace, not the workspace directly. */
export const WorkspaceAccessSchema = z.object({
  administrator: z.boolean().optional(),
  workspace: WorkspaceSchema,
});
export type WorkspaceAccess = z.infer<typeof WorkspaceAccessSchema>;

export const UserSchema = z.object({
  // uuid is optional: nested user summaries (PR author/reviewers/comment
  // author) are deliberately trimmed via `fields=` to just display_name for
  // token economy - uuid is only present when a user is fetched directly.
  uuid: z.string().optional(),
  display_name: z.string(),
  nickname: z.string().optional(),
});
export type User = z.infer<typeof UserSchema>;

export const RepositorySchema = z.object({
  uuid: z.string(),
  name: z.string(),
  full_name: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  is_private: z.boolean().optional(),
  mainbranch: z.object({ name: z.string() }).optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const BranchSchema = z.object({
  name: z.string(),
  target: z.object({ hash: z.string(), date: z.string().optional() }).optional(),
});
export type Branch = z.infer<typeof BranchSchema>;

export const TagSchema = z.object({
  name: z.string(),
  target: z.object({ hash: z.string() }).optional(),
});
export type Tag = z.infer<typeof TagSchema>;

export const CommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
  date: z.string(),
  author: z.object({ user: UserSchema.optional(), raw: z.string().optional() }).optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
export type Commit = z.infer<typeof CommitSchema>;

export const CommitStatusSchema = z.object({
  key: z.string(),
  name: z.string().optional(),
  state: z.enum(["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"]),
  url: z.string().optional(),
  description: z.string().optional(),
});
export type CommitStatus = z.infer<typeof CommitStatusSchema>;

export const PullRequestStateSchema = z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
export type PullRequestState = z.infer<typeof PullRequestStateSchema>;

/**
 * A user's role on one PR - the same shape whether embedded in a pull
 * request's `participants` array or returned directly by /approve and
 * /request-changes (confirmed against the live OpenAPI spec: both return a
 * `participant` object, not the full pull request). `state` is a plain
 * string rather than an enum of the two known values ("approved",
 * "changes_requested") - live PR data hasn't surfaced anything else, but
 * nothing here branches on the literal value, so there's no upside to
 * rejecting a future or undocumented one.
 */
export const ParticipantSchema = z.object({
  user: UserSchema.optional(),
  role: z.enum(["PARTICIPANT", "REVIEWER"]).optional(),
  approved: z.boolean().optional(),
  state: z.string().nullable().optional(),
  // Confirmed live: a participant who hasn't acted yet sends this as an
  // explicit null, not an absent field - .optional() alone rejected it.
  participated_on: z.string().nullish(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const PullRequestSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().optional(),
  state: PullRequestStateSchema,
  // Cheap, high-signal fields for at-a-glance review status without a
  // separate call - draft status and comment/task counts are exactly the
  // kind of thing worth including by default; the full comment/task
  // objects are not (see comment/task-list tools for those).
  draft: z.boolean().optional(),
  comment_count: z.number().optional(),
  task_count: z.number().optional(),
  author: UserSchema.optional(),
  source: z.object({ branch: z.object({ name: z.string() }) }).optional(),
  destination: z.object({ branch: z.object({ name: z.string() }) }).optional(),
  reviewers: z.array(UserSchema).optional(),
  participants: z.array(ParticipantSchema).optional(),
  created_on: z.string().optional(),
  updated_on: z.string().optional(),
  links: z.object({ html: z.object({ href: z.string() }).optional() }).optional(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** What POST .../comments/{id}/resolve returns - confirmed via spec: a resolution record, not the comment itself. */
export const CommentResolutionSchema = z.object({
  type: z.string(),
  user: UserSchema.optional(),
  created_on: z.string().optional(),
});
export type CommentResolution = z.infer<typeof CommentResolutionSchema>;

export const CommentSchema = z.object({
  id: z.number(),
  content: z.object({ raw: z.string() }),
  user: UserSchema.optional(),
  // Confirmed live against a real Bitbucket PR comment: `from` (and
  // plausibly `to`) can be explicitly null, not just absent, for a
  // single-line inline comment - .optional() alone rejected a real response.
  inline: z.object({ path: z.string(), to: z.number().nullish(), from: z.number().nullish() }).optional(),
  created_on: z.string().optional(),
  deleted: z.boolean().optional(),
  // Genuinely private, not just "unpublished" the way a draft PR still is:
  // a pending comment is invisible to everyone but its author until they
  // submit their review in Bitbucket - confirmed via the official
  // "batched comments" feature announcement (see tools/pullRequests.ts).
  pending: z.boolean().optional(),
});
export type Comment = z.infer<typeof CommentSchema>;

export const DiffStatEntrySchema = z.object({
  status: z.enum(["added", "removed", "modified", "renamed"]),
  lines_added: z.number().optional(),
  lines_removed: z.number().optional(),
  old: z.object({ path: z.string() }).optional(),
  new: z.object({ path: z.string() }).optional(),
});
export type DiffStatEntry = z.infer<typeof DiffStatEntrySchema>;

export const CodeSearchResultSchema = z.object({
  path_matches: z.array(z.object({ path: z.string() })).optional(),
  file: z.object({ path: z.string() }),
  content_matches: z.array(
    z.object({
      lines: z.array(z.object({ line: z.number(), segments: z.array(z.object({ text: z.string(), match: z.boolean().optional() })) })),
    }),
  ),
});
export type CodeSearchResult = z.infer<typeof CodeSearchResultSchema>;

/**
 * GET .../src/{commit}/{path} returns one of two shapes depending on
 * whether `path` points to a file or a directory (confirmed via the live
 * spec's description, not just the formal schema, which under-documents
 * this endpoint): a directory listing (this schema, paginated) or raw file
 * bytes/text (handled separately in bitbucket/client.ts's existing
 * content-type branch - see tools/source.ts).
 */
export const TreeEntrySchema = z.object({
  type: z.enum(["commit_file", "commit_directory"]),
  path: z.string(),
  size: z.number().optional(),
  // Spec formally types this as a single string but the field is
  // conventionally a list in practice - accept either rather than let an
  // ambiguous, non-critical field break validation of the whole entry.
  attributes: z.union([z.array(z.string()), z.string()]).optional(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

/**
 * GET .../merge/task-status/{task_id} - polled when a merge doesn't
 * complete synchronously (see tools/pullRequests.ts's merge handler).
 * merge_result is only present once task_status is SUCCESS.
 */
export const MergeTaskStatusSchema = z.object({
  task_status: z.enum(["PENDING", "SUCCESS", "FAILED"]),
  merge_result: PullRequestSchema.optional(),
});
export type MergeTaskStatus = z.infer<typeof MergeTaskStatusSchema>;

/** GET /workspaces/{workspace}/members - resolves a teammate's uuid from their name, the missing piece for pull_request_create's reviewers field (which requires real uuids, not names). */
export const WorkspaceMembershipSchema = z.object({
  user: UserSchema,
});
export type WorkspaceMembership = z.infer<typeof WorkspaceMembershipSchema>;

/** A pull request "task" - a checklist item, distinct from a comment. PullRequestSchema.task_count already surfaces the count; this is what's behind that number. */
export const TaskSchema = z.object({
  id: z.number(),
  state: z.enum(["RESOLVED", "UNRESOLVED"]),
  content: z.object({ raw: z.string() }),
  // Confirmed live: at least one real task sent this as an explicit null
  // rather than omitting it - .optional() alone rejected it.
  creator: UserSchema.nullish(),
  // Same private-until-submitted semantics as CommentSchema.pending - a
  // pending task is invisible to everyone but its author until they submit
  // their review in Bitbucket.
  pending: z.boolean().optional(),
});
export type Task = z.infer<typeof TaskSchema>;
