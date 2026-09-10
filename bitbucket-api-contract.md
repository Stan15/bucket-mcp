# Bitbucket Cloud REST API — Contract Reference for an MCP Server

Source of truth: live `https://api.bitbucket.org/swagger.json` (OpenAPI 2.0, 171 paths, snapshotted 2026-09-09) plus official Atlassian docs (`developer.atlassian.com/cloud/bitbucket`, `support.atlassian.com/bitbucket-cloud`). No third-party or MCP-implementation sources were consulted. Scope: **Bitbucket Cloud only** — Data Center/Server uses a structurally different API (offset pagination, `project→repo` hierarchy, Application-Link OAuth) and a shrinking self-hosted user base; supporting it would roughly double auth-flow and data-mapping complexity for a legacy track. If DC support is ever required, build it as a separate adapter sharing only the tool-interface contract below, not a unified client.

Types below are illustrative TypeScript, not a literal SDK — the point is the contract shape and the one-line rationale on each member, not a compilable file.

---

## 1. Authentication

```typescript
/** Every viable way to call the Bitbucket Cloud API as of 2026-09. Basic auth with a real account password, OAuth Implicit grant, OAuth ROPC grant, and App Passwords are all dead — omitted, not just discouraged. */
type BitbucketCredential =
  | OAuth2AuthCodeCredential
  | OAuth2ClientCredentialsCredential
  | ApiTokenCredential
  | RepositoryAccessTokenCredential
  | ProjectAccessTokenCredential
  | WorkspaceAccessTokenCredential;

/** User-delegated OAuth 2.0 (RFC 6749 §4.1). Use when the MCP acts as a specific human across every workspace/repo that human can reach — the only credential type that reflects a real user's full permission set without per-resource token minting. */
interface OAuth2AuthCodeCredential {
  kind: "oauth2_auth_code";
  accessToken: string;
  /** 1 hour from issuance. A 401 on an otherwise-valid call means this expired — refresh, don't retry. */
  expiresAt: Date;
  /** Exchanging this rotates it: the old refresh token is invalidated the moment a new pair is issued. An unused refresh token dies after 3 months, forcing a full re-auth — an MCP holding a long-lived session must exercise it periodically. */
  refreshToken: string;
}

/** App-only OAuth 2.0 (RFC 6749 §4.4). Represents the app/consumer owner's identity, not a delegated user — use for service-to-service calls where no human is present to authorize, understanding that "whose repos can this see" = the app owner's, not an arbitrary caller's. */
interface OAuth2ClientCredentialsCredential {
  kind: "oauth2_client_credentials";
  accessToken: string;
  expiresAt: Date;
}

/** The current standard personal credential, replacing App Passwords (fully removed 2026-07-28). Created with a mandatory expiry (max 1 year) and a scope set chosen from the granular `{read|write|admin|delete}:{resource}:bitbucket` model (§2.2) — cannot be viewed or edited after creation, only rotated. Usable as `Authorization: Bearer <token>` or `Basic base64(email:token)`. */
interface ApiTokenCredential {
  kind: "api_token";
  token: string;
  email?: string;
}

/** Non-user Bearer credential scoped to exactly one repository — the right shape for a CI/bot identity that should never see sibling repos. Up to 25 such tokens exist per workspace, a hard cap shared across all three Access Token kinds below. */
interface RepositoryAccessTokenCredential {
  kind: "repository_access_token";
  token: string;
  repositorySlug: string;
}

/** Same model as above, scoped to every repo under one project. Premium-plan-only feature. */
interface ProjectAccessTokenCredential {
  kind: "project_access_token";
  token: string;
  projectKey: string;
}

/** Same model, scoped to an entire workspace — typical use is a single CI/CD service identity for the whole org. Premium-plan-only feature. */
interface WorkspaceAccessTokenCredential {
  kind: "workspace_access_token";
  token: string;
  workspaceSlug: string;
}
```

**Explicitly dead, do not implement:** Basic auth with a real password; OAuth Implicit grant (§4.2); OAuth ROPC grant (§4.3); App Passwords (creation blocked 2025-09-09, fully removed 2026-07-28). SSH keys authenticate `git` protocol operations only — never usable for a REST call to `api.bitbucket.org`.

### 1.1 Scope introspection — can a caller discover what a token can do?

**Yes, and it's cheap: every API response — success or failure — carries the caller's actual granted scopes and the called endpoint's required scopes as headers.** Verification status differs per header:

- `x-accepted-oauth-scopes` (what the endpoint requires) — **directly confirmed live**, including unauthenticated: `curl -sI https://api.bitbucket.org/2.0/repositories/atlassian` returns `x-accepted-oauth-scopes: repository` with no token presented at all.
- `x-oauth-scopes` (what the presented credential actually holds — the half the dynamic-gating design below depends on) — **sourced from the official Atlassian Support KB, not independently observed here**, since that requires a real token to appear at all. Smoke-test this specific header against a live token before depending on it in production.

```typescript
/** Read straight off any API response. No dedicated introspection endpoint (no RFC 7662 `/oauth2/introspect`) exists or is needed — these headers are the documented mechanism. */
interface BitbucketScopeHeaders {
  /** Comma-separated list of every scope the presented credential actually holds. Present on OAuth access tokens and scoped API tokens; unconfirmed (inferred only) for Repository/Project/Workspace Access Tokens — smoke-test before relying on it for that credential kind. */
  "x-oauth-scopes"?: string;
  /** The scope(s) the specific endpoint just called requires. Diff this against x-oauth-scopes to know exactly what's missing, per endpoint, without guessing. */
  "x-accepted-oauth-scopes": string;
  /** Which auth mechanism Bitbucket detected for this request, e.g. "api_token", "oauth", "unauthenticated_identity". */
  "x-credential-type": string;
}

/**
 * Recommended MCP startup probe: one cheap unscoped call (GET /2.0/user needs
 * no scope at all) reveals the configured credential's full scope set via
 * `x-oauth-scopes`, without needing an admin-level credential to probe itself.
 * Use the result to decide which tool families to register (§4 dynamic gating).
 */
declare function probeGrantedScopes(credential: BitbucketCredential): Promise<string[]>;
```

Two complementary **business-permission** endpoints report the caller's actual role/permission on resources (distinct from OAuth scope — this is "what can this account do" vs "what did we authorize this token for"), and neither requires admin-level access to call:

```typescript
/** Every workspace the caller can access, with effective role. Needs classic `account` scope or granular `read:workspace:bitbucket`. */
declare function getMyWorkspacePermissions(): Promise<{ workspace: Workspace; permission: "owner" | "member" }[]>;

/** Every repo the caller has explicit access to, with effective permission level. Filterable/sortable via the standard q=/sort= BBQL syntax. Needs `account`+`repository` (classic) or `read:workspace:bitbucket`+`read:repository:bitbucket` (granular). */
declare function getMyRepositoryPermissions(query?: BbqlQuery): Promise<Paginated<{ repository: Repository; permission: "admin" | "write" | "read" }>>;
```

### 1.2 Scope model

Bitbucket runs **two parallel scope namespaces** on the same OAuth2 security scheme — classic (legacy, still authoritative in the OAuth Consumer UI) and granular (newer, RBAC-shaped, used by scoped API tokens and surfaced per-endpoint in the OpenAPI spec's `x-atlassian-oauth2-scopes` extension). An endpoint's declared requirement is effectively an OR across whichever namespace the credential type uses.

```typescript
/** Classic scopes — coarse, resource-family-level, each often implying a related read scope. Omitting `scopes` entirely when registering an OAuth consumer requests everything; always declare an explicit minimal list. */
type ClassicScope =
  | "repository" | "repository:write" | "repository:admin" | "repository:delete"
  | "project" | "project:admin"
  | "pullrequest" | "pullrequest:write"
  | "issue" | "issue:write"
  | "wiki"
  | "webhook"
  | "snippet" | "snippet:write"
  | "email" | "account" | "account:write" | "team" | "team:write"
  | "pipeline" | "pipeline:write" | "pipeline:variable"
  | "runner" | "runner:write"
  | "test" | "test:write";

/** Granular scopes — the finer-grained `{verb}:{resource}:bitbucket` model. Prefer these when minting new scoped API tokens: they let a credential be e.g. read-only on pull requests while write-capable on nothing else, which no classic scope combination expresses as tightly. */
type GranularScope = `${"read" | "write" | "admin" | "delete"}:${GranularResource}:bitbucket`;
type GranularResource =
  | "repository" | "pullrequest" | "project" | "workspace" | "user"
  | "pipeline" | "runner" | "issue" | "webhook" | "snippet" | "wiki"
  | "ssh-key" | "gpg-key" | "permission";
// Not every verb applies to every resource — e.g. pullrequest has no admin/delete tier, project has no write tier (only read/admin). Verify per-resource before offering a scope picker.
```

**Design implication for tool gating:** at startup, resolve `probeGrantedScopes()` into a `Set<ClassicScope | GranularScope>`, then register only the tool families whose minimum required scope is present. Fall back to per-call `403` handling regardless — MCP client support for reacting to a changed tool set (`tools/list_changed`) is inconsistent, so the scope gate is a UX optimization, not the only enforcement layer.

---

## 2. Response shaping (the actual token-economy levers)

```typescript
/** Every list endpoint's envelope. Only `values` and `next` are guaranteed — `next` is absent on the last page. Never hand-construct a page URL from `page`/`pagelen`; follow `next` verbatim, since Bitbucket reserves the right to change pagination style per endpoint. */
interface PaginatedResponse<T> {
  size?: number;
  page?: number;
  pagelen?: number;
  next?: string;
  previous?: string;
  values: T[];
}

/**
 * Partial-response selector. Apply internally on every call an MCP tool makes
 * — never ask the model to construct this string itself. This is the single
 * biggest lever on response size for a chatty API like Bitbucket's.
 * Grammar: comma-separated field names; dot-notation into nested/array
 * objects (`values.links.self.href`); `-field` excludes from the default
 * partial shape; `+field` adds one field on top of the default without
 * hand-enumerating the rest; `*` (or a trailing `.*`) requests everything
 * at that level.
 */
type FieldsParam = string;

/**
 * Bitbucket Query Language, accepted by most (not all — some endpoints
 * silently ignore it, e.g. `environments`; verify per-endpoint and fail
 * open rather than error) list endpoints via `?q=`.
 * Operators: `~` contains, `=`, `!=`, `>`, `>=`, `<`, `<=`; `AND`/`OR`/negation;
 * quoted string literals; ISO-8601 dates. Field paths mirror the JSON
 * response shape, e.g. `state = "OPEN" AND target.branch.name = "main"`.
 */
type BbqlQuery = string;

/** Sort key for `?sort=`; prefix `-` for descending, e.g. `-created_on`. */
type SortParam = string;
```

```typescript
/** Three cost tiers for "what changed" on a commit or pull request — pick the cheapest one that answers the question. */
interface DiffTiers {
  /** Per-file change type + line counts only, no content. Default choice for "what changed" — never default to full diff. */
  diffstat(): Promise<{ status: "added" | "removed" | "modified" | "renamed"; path: string; linesAdded: number; linesRemoved: number }[]>;
  /** Full unified diff text. Supports `path` to scope to one file, `context`, `ignore_whitespace`, `binary`, `renames`. Offer as an explicit opt-in tool, never inlined by default. */
  diff(options?: { path?: string; context?: number }): Promise<string>;
  /** git-apply-able patch including commit metadata — for actually applying/cherry-picking, not for reading. */
  patch(): Promise<string>;
}
```

---

## 3. Resource groups

Each group lists its methods with the minimum classic scope. Consult the granular-scope table (§1.2) for the tighter equivalent. Counts are live endpoint counts from the swagger spec, not a target tool count — an MCP tool typically collapses several REST endpoints (e.g. `diff`/`diffstat`/`patch`) into one parametrized tool.

```typescript
/** 29 endpoints. Core repo lifecycle, file browsing, hooks, permissions. */
interface RepositoriesApi {
  list(workspace?: string, query?: { role?: string; q?: BbqlQuery; sort?: SortParam }): Promise<PaginatedResponse<Repository>>;
  get(workspace: string, repoSlug: string): Promise<Repository>;
  /** repository:admin */
  create(workspace: string, repoSlug: string, body: RepositoryInput): Promise<Repository>;
  /** repository:admin */
  update(workspace: string, repoSlug: string, body: Partial<RepositoryInput>): Promise<Repository>;
  /** repository:delete */
  delete(workspace: string, repoSlug: string): Promise<void>;
  listForks(workspace: string, repoSlug: string): Promise<PaginatedResponse<Repository>>;
  /** repository:write */
  fork(workspace: string, repoSlug: string): Promise<Repository>;
  /** Root directory listing of the main branch, or file/dir contents at a specific revision+path. */
  getSource(workspace: string, repoSlug: string, revision?: string, path?: string): Promise<SourceEntry | string>;
  /** repository:write. Create a commit by uploading file content directly — no local clone needed. */
  putSource(workspace: string, repoSlug: string, files: Record<string, string | Blob>, branch: string, message: string): Promise<void>;
  /** webhook (read) / webhook (write for mutating methods) */
  webhooks: WebhooksSubApi;
  /** repository:admin. Explicit per-user/per-group permission grants, distinct from workspace-level default permissions. */
  permissionsConfig: PermissionsConfigSubApi;
}

/** 38 endpoints — the largest single collaboration surface. */
interface PullRequestsApi {
  list(workspace: string, repoSlug: string, state?: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED"): Promise<PaginatedResponse<PullRequest>>;
  get(workspace: string, repoSlug: string, id: number): Promise<PullRequest>;
  /** pullrequest:write */
  create(workspace: string, repoSlug: string, body: PullRequestInput): Promise<PullRequest>;
  /** pullrequest:write. Title, description, reviewers, destination branch. */
  update(workspace: string, repoSlug: string, id: number, body: Partial<PullRequestInput>): Promise<PullRequest>;
  /** pullrequest:write */
  approve(workspace: string, repoSlug: string, id: number): Promise<void>;
  unapprove(workspace: string, repoSlug: string, id: number): Promise<void>;
  requestChanges(workspace: string, repoSlug: string, id: number): Promise<void>;
  /** pullrequest:write */
  decline(workspace: string, repoSlug: string, id: number): Promise<void>;
  /** pullrequest:write. Async — returns a task to poll via getMergeStatus. */
  merge(workspace: string, repoSlug: string, id: number, strategy?: "merge_commit" | "squash" | "fast_forward"): Promise<{ taskId: string }>;
  getMergeStatus(workspace: string, repoSlug: string, id: number, taskId: string): Promise<{ status: "PENDING" | "SUCCESS" | "FAILED" }>;
  diffTiers(workspace: string, repoSlug: string, id: number): DiffTiers;
  listCommits(workspace: string, repoSlug: string, id: number): Promise<PaginatedResponse<Commit>>;
  listConflicts(workspace: string, repoSlug: string, id: number): Promise<Conflict[]>;
  /** Build/commit statuses on the PR's current head. */
  listStatuses(workspace: string, repoSlug: string, id: number): Promise<PaginatedResponse<CommitStatus>>;
  /** Approvals, updates, comments — the full event log for a PR. */
  listActivity(workspace: string, repoSlug: string, id: number): Promise<PaginatedResponse<PullRequestActivityEvent>>;
  /** Supports inline (file+line-anchored) comments via body fields. */
  comments: CommentsSubApi;
  /** pullrequest. PR checklist items ("tasks" in Bitbucket's UI, unrelated to MCP `tasks`). */
  tasks: PrTasksSubApi;
  /** Repo-level and inherited-from-project default reviewer configuration. */
  defaultReviewers(workspace: string, repoSlug: string): Promise<{ effective: User[] }>;
}

/** 26+5 endpoints. Commits, statuses, and Code Insights (CI/quality report annotations). */
interface CommitsApi {
  list(workspace: string, repoSlug: string, revision?: string): Promise<PaginatedResponse<Commit>>;
  get(workspace: string, repoSlug: string, commit: string): Promise<Commit>;
  /** repository:write */
  approve(workspace: string, repoSlug: string, commit: string): Promise<void>;
  comments: CommentsSubApi;
  diffTiers(workspace: string, repoSlug: string, spec: string): DiffTiers;
  mergeBase(workspace: string, repoSlug: string, revspec: string): Promise<Commit>;
  listStatuses(workspace: string, repoSlug: string, commit: string): Promise<PaginatedResponse<CommitStatus>>;
  /** Create/update a build status — the mechanism CI systems use to post pass/fail back onto a commit. */
  putBuildStatus(workspace: string, repoSlug: string, commit: string, key: string, body: BuildStatusInput): Promise<CommitStatus>;
  /** "Code Insights": structured CI/quality reports with line-anchored annotations, distinct from build statuses. */
  reports: CodeInsightsSubApi;
}

/** 9 endpoints. */
interface RefsApi {
  listBranches(workspace: string, repoSlug: string, query?: { q?: BbqlQuery; sort?: SortParam }): Promise<PaginatedResponse<Branch>>;
  /** repository:write */
  createBranch(workspace: string, repoSlug: string, name: string, target: string): Promise<Branch>;
  deleteBranch(workspace: string, repoSlug: string, name: string): Promise<void>;
  listTags(workspace: string, repoSlug: string): Promise<PaginatedResponse<Tag>>;
  createTag(workspace: string, repoSlug: string, name: string, target: string): Promise<Tag>;
}

/** 5+7 endpoints. Merge-check rules and the branching-model (which branch is "main", naming conventions for feature/release/hotfix branches). repository:admin for writes; a project-level equivalent exists (project:admin) that repos inherit from. */
interface BranchGovernanceApi {
  listRestrictions(workspace: string, repoSlug: string): Promise<PaginatedResponse<BranchRestriction>>;
  putRestriction(workspace: string, repoSlug: string, id: string, body: BranchRestrictionInput): Promise<BranchRestriction>;
  getEffectiveBranchingModel(workspace: string, repoSlug: string): Promise<BranchingModel>;
}

/** 68 endpoints — the largest resource group. CI/CD: runs, steps, logs, test reports, variables at 4 scopes (repo/environment/workspace/per-user), scheduled runs, self-hosted runners, SSH deploy config, build caches. */
interface PipelinesApi {
  /** pipeline. Filterable by target ref/branch/commit, trigger type, status. */
  list(workspace: string, repoSlug: string, filters?: PipelineFilters): Promise<PaginatedResponse<Pipeline>>;
  /** pipeline. Manually trigger a run against a branch/tag/commit. */
  trigger(workspace: string, repoSlug: string, target: PipelineTarget): Promise<Pipeline>;
  get(workspace: string, repoSlug: string, pipelineUuid: string): Promise<Pipeline>;
  /** pipeline:write */
  stop(workspace: string, repoSlug: string, pipelineUuid: string): Promise<void>;
  listSteps(workspace: string, repoSlug: string, pipelineUuid: string): Promise<Step[]>;
  getStepLog(workspace: string, repoSlug: string, pipelineUuid: string, stepUuid: string): Promise<string>;
  getTestReports(workspace: string, repoSlug: string, pipelineUuid: string, stepUuid: string): Promise<TestReport>;
  /** pipeline:variable to write. Secured variables never return their value on GET — a write-only field by design, not a spec quirk to work around. */
  variables: PipelineVariablesSubApi;
  /** GET only — Bitbucket's OIDC identity provider endpoints so pipeline steps can auth to AWS/GCP/Azure via short-lived tokens instead of static secrets. No oauth2 scope required (public JWKS-style). Low relevance to a human-facing MCP; documented for completeness. */
  getOidcConfiguration(workspace: string): Promise<OidcConfig>;
}

/** 16 endpoints. Deployment records/environments, and repo/project-level SSH deploy keys. */
interface DeploymentsApi {
  listDeployments(workspace: string, repoSlug: string): Promise<PaginatedResponse<Deployment>>;
  listEnvironments(workspace: string, repoSlug: string): Promise<PaginatedResponse<Environment>>;
  deployKeys: DeployKeysSubApi;
}

/** 16 endpoints. Project-level grouping above repos; permissions and default reviewers inherited down to member repos. */
interface ProjectsApi {
  /** project:admin */
  create(workspace: string, body: ProjectInput): Promise<Project>;
  get(workspace: string, projectKey: string): Promise<Project>;
  update(workspace: string, projectKey: string, body: Partial<ProjectInput>): Promise<Project>;
  delete(workspace: string, projectKey: string): Promise<void>;
  defaultReviewers(workspace: string, projectKey: string): Promise<User[]>;
  permissionsConfig: PermissionsConfigSubApi;
}

/** 17 endpoints. Membership, permissions, GPG signing key, workspace-level hooks. */
interface WorkspacesApi {
  get(workspace: string): Promise<Workspace>;
  /** account. Every workspace the current credential can access. */
  listMine(): Promise<PaginatedResponse<Workspace>>;
  listMembers(workspace: string): Promise<PaginatedResponse<User>>;
  listProjects(workspace: string): Promise<PaginatedResponse<Project>>;
  webhooks: WebhooksSubApi;
}

/** 12 endpoints, includes discovery metadata. No documented HMAC signing field in the spec — verify against the webhooks doc before building signature verification for an inbound-webhook receiver. */
interface WebhooksSubApi {
  /** No scope — metadata only. Which resource types (repository, workspace, ...) and event types are subscribable. */
  listAvailableEvents(): Promise<{ subjectType: string; events: string[] }[]>;
  list(): Promise<PaginatedResponse<Webhook>>;
  /** webhook */
  create(body: WebhookInput): Promise<Webhook>;
  delete(uid: string): Promise<void>;
}

/** 24 endpoints. Standalone code snippets with full revision history, own diff/patch pair. */
interface SnippetsApi {
  create(workspace: string | undefined, body: SnippetInput): Promise<Snippet>;
  get(workspace: string, encodedId: string): Promise<Snippet>;
  listCommits(workspace: string, encodedId: string): Promise<PaginatedResponse<Commit>>;
  diffTiers(workspace: string, encodedId: string, revision: string): Pick<DiffTiers, "diff" | "patch">;
}

/** 3 endpoints, code search. `search_query` uses its own grammar, distinct from the `q=` BBQL used elsewhere — the spec doesn't detail it fully; confirm against the prose search docs before building a query builder. */
interface SearchApi {
  searchCode(workspace: string, searchQuery: string): Promise<PaginatedResponse<CodeSearchResult>>;
}

/** Account-scoped odds and ends: current user, emails, SSH/GPG keys (for git and commit-signature verification, not REST auth), and app-defined key/value properties attachable to commits/repos/PRs/users (low priority — primarily a Connect-app feature). */
interface UsersApi {
  getCurrentUser(): Promise<User>;
  getUser(selectedUser: string): Promise<User>;
}
```

---

## 4. Dynamic tool gating — end-to-end design

```typescript
/**
 * Called once at MCP server startup. Returns the tool families to register
 * given the configured credential's actual granted scopes — not what the
 * operator merely believes they configured.
 */
async function resolveAvailableTools(credential: BitbucketCredential): Promise<ToolFamily[]> {
  const granted = new Set(await probeGrantedScopes(credential));
  const families: ToolFamily[] = [];
  if (granted.has("repository") || granted.has("read:repository:bitbucket")) families.push("repositories", "commits", "refs");
  if (granted.has("pullrequest") || granted.has("read:pullrequest:bitbucket")) families.push("pull_requests");
  if (granted.has("pipeline") || granted.has("read:pipeline:bitbucket")) families.push("pipelines");
  if (granted.has("webhook") || granted.has("read:webhook:bitbucket")) families.push("webhooks");
  // ...remaining families follow the same pattern.
  return families;
}
```

This is a UX optimization, not a security boundary — Bitbucket itself enforces scope on every call regardless of what the MCP chose to advertise, so a `403` handler with a clear "your token lacks scope X" message must exist independent of this probe. Re-probe and emit `tools/list_changed` (MCP spec, see companion doc) if the server later detects a scope change (e.g. a `403` where the probe previously indicated the scope was present — the token may have been rotated to a narrower one out-of-band).

---

## 5. Known gaps / things to verify before hardcoding

- **Issue Tracker & Wiki**: scopes (`issue`, `wiki`) still exist and prose docs describe endpoints, but the live swagger spec has zero `/issues` or `/wiki` paths — these are legacy/best-effort, reachable only on repos with the feature enabled, with Atlassian signaling long-term Issue Tracker deprecation in favor of Jira. Implement behind a capability probe, don't assume availability, don't block v1 on them.
- **Repository/Project/Workspace Access Token scope-header behavior**: inferred (Bearer-authenticated like other tokens) but not directly confirmed in official docs — smoke-test before relying on `x-oauth-scopes` for these specifically.
- **Rate limits**: not in the swagger spec. Live-verified: unauthenticated requests carry `x-ratelimit-limit: 60, 60;w=3600` and `x-ratelimit-remaining`. Authenticated limits are higher and endpoint-dependent (search/pipeline-trigger have stricter budgets) — read `X-RateLimit-*`/`Retry-After` headers at runtime and back off; don't hardcode a single number.
- **Default/max `pagelen` per endpoint**: varies (commonly default 10 / max 100, some lower) and isn't globally documented — verify per-endpoint at call time rather than assuming.
- **Webhook payload signing**: no HMAC/signing-secret field found in the spec — confirm against the webhooks doc before building inbound signature verification.
