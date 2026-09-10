import { describe, expect, it } from "vitest";
import { BitbucketClient } from "../../src/bitbucket/client.js";
import { NoCredentialProvider, StaticTokenCredentialProvider } from "../../src/credentials.js";
import {
  BranchSchema,
  CodeSearchResultSchema,
  CommentSchema,
  CommitSchema,
  CommitStatusSchema,
  DiffStatEntrySchema,
  PullRequestSchema,
  RepositorySchema,
  TagSchema,
  TaskSchema,
  TreeEntrySchema,
  UserSchema,
  WorkspaceAccessSchema,
  WorkspaceMembershipSchema,
} from "../../src/bitbucket/types.js";

/**
 * The ONLY test file allowed to hit the real Bitbucket API (see
 * vitest.config.ts, which excludes this directory from `npm test` - run
 * these explicitly via `npm run test:contract`). Purpose: catch drift
 * between our Zod schemas and what Bitbucket actually returns, using a
 * real, stable, public repository - no state mutated, GET-only throughout.
 *
 * Two schemas can't be covered here and never will be by this suite:
 * MergeTaskStatusSchema (what a real merge's 202-async-poll response looks
 * like) and CommentResolutionSchema (what POST .../comments/{id}/resolve
 * returns) are both the shape of a write endpoint's response - actually
 * exercising them means merging a PR or resolving a comment for real,
 * which this suite's public-repo/no-mutation design can't do without
 * leaving damage in someone else's repository. Both are covered by mocked
 * unit tests instead (test/unit/tools/pullRequests.test.ts) - this file's
 * live-drift guarantee doesn't extend to them.
 */

// A real, public, unauthenticated-readable Bitbucket Cloud repo - confirmed
// live during development (2026-09-10). If these start failing, check
// whether the repo itself changed/moved before assuming our schemas drifted.
const WORKSPACE = "atlassian";
const REPO = "aui";

/**
 * Most reads here work fully unauthenticated (public repo, GET-only) - no
 * token is required for those. BITBUCKET_CONTRACT_TEST_TOKEN is optional for
 * them, purely for a higher rate limit: unauthenticated calls are capped at
 * 60/hour (confirmed live), which this suite alone can burn through in a
 * couple of runs during active development. A handful of tests below
 * (anything under an account's own identity: /user, /user/workspaces,
 * workspace membership) have no unauthenticated equivalent at all - Bitbucket
 * 401s them regardless - so those are gated on the token being present and
 * skipped otherwise. A token here needs read-only scopes only
 * (read:repository:bitbucket, read:pullrequest:bitbucket,
 * read:user:bitbucket, read:workspace:bitbucket) - every test in this file
 * is a GET.
 */
function realClient() {
  const token = process.env.BITBUCKET_CONTRACT_TEST_TOKEN;
  return new BitbucketClient(token ? new StaticTokenCredentialProvider(token) : new NoCredentialProvider());
}

describe("contract: real Bitbucket API responses match our schemas", () => {
  it("GET /repositories/{workspace}/{repo} matches RepositorySchema", async () => {
    const repo = await realClient().get(`/repositories/${WORKSPACE}/${REPO}`, undefined, RepositorySchema);
    expect(repo.full_name).toBe(`${WORKSPACE}/${REPO}`);
  }, 15_000);

  it("GET /repositories/{workspace}/{repo}/src/{revision}/ returns a directory listing matching TreeEntrySchema", async () => {
    const repo = await realClient().get(`/repositories/${WORKSPACE}/${REPO}`, undefined, RepositorySchema);
    const branch = repo.mainbranch?.name ?? "master";
    const { values } = await realClient().paginate<unknown>(
      `/repositories/${WORKSPACE}/${REPO}/src/${branch}/`,
      undefined,
      10,
    );
    expect(values.length).toBeGreaterThan(0);
    for (const entry of values) {
      expect(() => TreeEntrySchema.parse(entry)).not.toThrow();
    }
  }, 15_000);

  it("a file fetched with format=meta matches TreeEntrySchema directly (not paginated)", async () => {
    const repo = await realClient().get(`/repositories/${WORKSPACE}/${REPO}`, undefined, RepositorySchema);
    const branch = repo.mainbranch?.name ?? "master";
    const meta = await realClient().get(
      `/repositories/${WORKSPACE}/${REPO}/src/${branch}/package.json`,
      { format: "meta" },
      TreeEntrySchema,
    );
    expect(meta.type).toBe("commit_file");
  }, 15_000);

  it("raw file content comes back as text, not JSON (confirms bitbucket/client.ts's content-type branch is exercised for real)", async () => {
    const repo = await realClient().get(`/repositories/${WORKSPACE}/${REPO}`, undefined, RepositorySchema);
    const branch = repo.mainbranch?.name ?? "master";
    const content = await realClient().get<string>(`/repositories/${WORKSPACE}/${REPO}/src/${branch}/package.json`);
    expect(typeof content).toBe("string");
    expect(() => JSON.parse(content)).not.toThrow(); // package.json IS valid JSON content, just served as text/plain
  }, 15_000);

  it("GET .../pullrequests matches PullRequestSchema, including draft/comment_count/task_count", async () => {
    const { values } = await realClient().paginate(
      `/repositories/${WORKSPACE}/${REPO}/pullrequests`,
      { state: "MERGED", fields: "next,values.id,values.title,values.state,values.draft,values.comment_count,values.task_count" },
      3,
      PullRequestSchema,
    );
    expect(values.length).toBeGreaterThan(0);
    expect(values[0].state).toBe("MERGED");
    expect(typeof values[0].comment_count).toBe("number");
  }, 15_000);

  it("GET .../commits and .../commit/{hash} match CommitSchema", async () => {
    const { values } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/commits`, undefined, 1, CommitSchema);
    expect(values).toHaveLength(1);
    const commit = await realClient().get(`/repositories/${WORKSPACE}/${REPO}/commit/${values[0].hash}`, undefined, CommitSchema);
    expect(commit.hash).toBe(values[0].hash);
  }, 15_000);

  it("GET .../commit/{hash}/statuses matches CommitStatusSchema", async () => {
    const { values: commits } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/commits`, undefined, 5, CommitSchema);
    let found = false;
    for (const commit of commits) {
      const { values: statuses } = await realClient().paginate(
        `/repositories/${WORKSPACE}/${REPO}/commit/${commit.hash}/statuses`,
        undefined,
        1,
        CommitStatusSchema,
      );
      if (statuses.length > 0) {
        expect(["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"]).toContain(statuses[0].state);
        found = true;
        break;
      }
    }
    expect(found).toBe(true); // if this repo stops having any recent build statuses, swap to one that does
  }, 20_000);

  it("GET .../pullrequests/{id}/comments matches CommentSchema against a real reviewed PR", async () => {
    const { values } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/pullrequests/5452/comments`, undefined, 5, CommentSchema);
    expect(values.length).toBeGreaterThan(0);
    expect(values[0].content.raw.length).toBeGreaterThan(0);
  }, 15_000);

  it("GET .../refs/branches and .../refs/tags match their schemas", async () => {
    const { values: branches } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/refs/branches`, undefined, 3, BranchSchema);
    expect(branches.length).toBeGreaterThan(0);
    const { values: tags } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/refs/tags`, undefined, 3, TagSchema);
    expect(tags.length).toBeGreaterThan(0);
  }, 15_000);

  it("GET .../search/code matches CodeSearchResultSchema", async () => {
    const { values } = await realClient().paginate(
      `/workspaces/${WORKSPACE}/search/code`,
      { search_query: `function repo:${REPO}` },
      3,
      CodeSearchResultSchema,
    );
    expect(values.length).toBeGreaterThan(0);
  }, 15_000);

  it("GET .../pullrequests/{id} (full, untrimmed fields) matches PullRequestSchema's participants - not just the trimmed list shape", async () => {
    // The list-endpoint test above requests a narrow `fields=` set that
    // excludes `participants` entirely, so it never exercises that part of
    // PullRequestSchema. Fetching one PR in full is the only way to confirm
    // the embedded participant shape (user/role/approved/state) actually
    // matches what Bitbucket sends, not just what the standalone
    // approve/request-changes endpoints return.
    const pr = await realClient().get(`/repositories/${WORKSPACE}/${REPO}/pullrequests/5452`, undefined, PullRequestSchema);
    expect(pr.participants?.length).toBeGreaterThan(0);
    expect(pr.participants?.[0].user?.display_name.length).toBeGreaterThan(0);
  }, 15_000);

  it("GET .../pullrequests/{id}/tasks matches TaskSchema against a real resolved task", async () => {
    const { values } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/pullrequests/5452/tasks`, undefined, 5, TaskSchema);
    expect(values.length).toBeGreaterThan(0);
    expect(["RESOLVED", "UNRESOLVED"]).toContain(values[0].state);
  }, 15_000);

  it("GET .../diffstat/{spec} matches DiffStatEntrySchema", async () => {
    const { values: commits } = await realClient().paginate(`/repositories/${WORKSPACE}/${REPO}/commits`, undefined, 1, CommitSchema);
    const { values } = await realClient().paginate(
      `/repositories/${WORKSPACE}/${REPO}/diffstat/${commits[0].hash}`,
      undefined,
      5,
      DiffStatEntrySchema,
    );
    expect(values.length).toBeGreaterThan(0);
  }, 15_000);

  // /user, /user/workspaces, and /workspaces/{workspace}/members all require
  // an authenticated identity - there's no unauthenticated equivalent to
  // fall back to (confirmed live: /workspaces/atlassian/members returns 401
  // with no token). These three run only when BITBUCKET_CONTRACT_TEST_TOKEN
  // is set; without it they're skipped rather than failed, since a personal
  // token isn't something a public CI run can assume it has.
  const hasToken = Boolean(process.env.BITBUCKET_CONTRACT_TEST_TOKEN);

  describe.skipIf(!hasToken)("authenticated-only endpoints (needs BITBUCKET_CONTRACT_TEST_TOKEN)", () => {
    it("GET /user matches UserSchema", async () => {
      const user = await realClient().get("/user", undefined, UserSchema);
      expect(user.display_name.length).toBeGreaterThan(0);
    }, 15_000);

    it("GET /user/workspaces matches WorkspaceAccessSchema, and GET /workspaces/{slug}/members matches WorkspaceMembershipSchema", async () => {
      const { values: workspaces } = await realClient().paginate("/user/workspaces", undefined, 1, WorkspaceAccessSchema);
      expect(workspaces.length).toBeGreaterThan(0);

      // Member listing needs the token's OWN workspace, not the fixed public
      // "atlassian" one used elsewhere in this file - confirmed live that
      // it 401s for a workspace the caller doesn't belong to.
      const { values: members } = await realClient().paginate(
        `/workspaces/${workspaces[0].workspace.slug}/members`,
        undefined,
        5,
        WorkspaceMembershipSchema,
      );
      expect(members.length).toBeGreaterThan(0);
    }, 15_000);
  });
});
