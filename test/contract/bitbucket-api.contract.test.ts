import { describe, expect, it } from "vitest";
import { BitbucketClient } from "../../src/bitbucket/client.js";
import { NoCredentialProvider, StaticTokenCredentialProvider } from "../../src/credentials.js";
import {
  BranchSchema,
  CodeSearchResultSchema,
  CommentSchema,
  CommitSchema,
  CommitStatusSchema,
  PullRequestSchema,
  RepositorySchema,
  TagSchema,
  TreeEntrySchema,
} from "../../src/bitbucket/types.js";

/**
 * The ONLY test file allowed to hit the real Bitbucket API (see
 * vitest.config.ts, which excludes this directory from `npm test` - run
 * these explicitly via `npm run test:contract`). Purpose: catch drift
 * between our Zod schemas and what Bitbucket actually returns, using a
 * real, stable, public repository - no credential required, no state
 * mutated (GET-only).
 */

// A real, public, unauthenticated-readable Bitbucket Cloud repo - confirmed
// live during development (2026-09-10). If these start failing, check
// whether the repo itself changed/moved before assuming our schemas drifted.
const WORKSPACE = "atlassian";
const REPO = "aui";

/**
 * All reads here work fully unauthenticated (public repo, GET-only) - no
 * token is required to run this suite. BITBUCKET_CONTRACT_TEST_TOKEN is an
 * optional escape hatch purely for a higher rate limit: unauthenticated
 * calls are capped at 60/hour (confirmed live), which this suite alone can
 * burn through in a couple of runs during active development. A token here
 * needs read-only scopes only (read:repository:bitbucket,
 * read:pullrequest:bitbucket) - every test in this file is a GET.
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
});
