import { afterEach, describe, expect, it, vi } from "vitest";
import { testBitbucketClient } from "../../support/testClient.js";
import { route } from "../../support/fakeFetch.js";
import { pullRequestTools } from "../../../src/tools/pullRequests.js";
import { RequestContext } from "../../../src/context.js";

function tool(name: string) {
  const found = pullRequestTools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

const args = { workspace: "ws", repoSlug: "repo", id: 1 };

describe("bitbucket_pull_request_merge", () => {
  afterEach(() => vi.useRealTimers());

  it("returns the merged PR directly on a synchronous 200", async () => {
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", { status: 200, body: { id: 1, title: "x", state: "MERGED" } }),
    ]);
    const result = await tool("bitbucket_pull_request_merge").handler({ ...args, strategy: "merge_commit" }, { bitbucket } as RequestContext);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ pullRequest: { state: "MERGED" } });
  });

  it("polls the task-status endpoint on a 202 and resolves once it succeeds", async () => {
    vi.useFakeTimers();
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", {
        status: 202,
        headers: { location: "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/1/merge/task-status/task-abc" },
      }),
      // First poll: still pending.
      route("GET", "/2.0/repositories/ws/repo/pullrequests/1/merge/task-status/task-abc", { status: 200, body: { task_status: "PENDING" } }),
      // Second poll: done.
      route("GET", "/2.0/repositories/ws/repo/pullrequests/1/merge/task-status/task-abc", {
        status: 200,
        body: { task_status: "SUCCESS", merge_result: { id: 1, title: "x", state: "MERGED" } },
      }),
    ]);

    const promise = tool("bitbucket_pull_request_merge").handler({ ...args, strategy: "merge_commit" }, { bitbucket } as RequestContext);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ pullRequest: { state: "MERGED" } });
  });

  it("gives up after exhausting poll attempts and returns the task ID rather than hanging or erroring", async () => {
    vi.useFakeTimers();
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", {
        status: 202,
        headers: { location: "https://api.bitbucket.org/2.0/.../task-status/task-xyz" },
      }),
      ...Array.from({ length: 5 }, () =>
        route("GET", "/2.0/repositories/ws/repo/pullrequests/1/merge/task-status/task-xyz", { status: 200, body: { task_status: "PENDING" } }),
      ),
    ]);

    const promise = tool("bitbucket_pull_request_merge").handler({ ...args, strategy: "merge_commit" }, { bitbucket } as RequestContext);
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await promise;

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ taskId: "task-xyz", status: "PENDING" });
  });

  it("gives a specific, actionable message on a 555 server-side timeout", async () => {
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", { status: 555, body: { type: "error", error: { message: "merge timed out" } } }),
    ]);
    const result = await tool("bitbucket_pull_request_merge").handler({ ...args, strategy: "merge_commit" }, { bitbucket } as RequestContext);
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("safe to retry");
  });

  it("gives a specific, actionable message on a 409 ref-changed conflict", async () => {
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", { status: 409, body: { type: "error", error: { message: "ref changed" } } }),
    ]);
    const result = await tool("bitbucket_pull_request_merge").handler({ ...args, strategy: "merge_commit" }, { bitbucket } as RequestContext);
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("Refresh the PR and retry");
  });
});

describe("bitbucket_pull_request_approve", () => {
  it("surfaces Bitbucket's real participant record, not a hardcoded echo", async () => {
    const bitbucket = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/approve", {
        status: 200,
        body: { user: { display_name: "Stan" }, role: "REVIEWER", approved: true, state: "approved" },
      }),
    ]);
    const result = await tool("bitbucket_pull_request_approve").handler(args, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ participant: { state: "approved", user: { display_name: "Stan" } } });
  });
});

describe("bitbucket_pull_request_task_list", () => {
  it("lists tasks distinct from comments", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/pullrequests/1/tasks", {
        status: 200,
        body: { values: [{ id: 7, state: "UNRESOLVED", content: { raw: "fix the typo" }, creator: { display_name: "Stan" } }] },
      }),
    ]);
    const result = await tool("bitbucket_pull_request_task_list").handler(args, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ tasks: [{ id: 7, state: "UNRESOLVED" }] });
  });
});

describe("bitbucket_pull_request_task_resolve", () => {
  it("PUTs state:RESOLVED and returns the updated task", async () => {
    const bitbucket = testBitbucketClient([
      route("PUT", "/2.0/repositories/ws/repo/pullrequests/1/tasks/7", {
        status: 200,
        body: { id: 7, state: "RESOLVED", content: { raw: "fix the typo" } },
      }),
    ]);
    const result = await tool("bitbucket_pull_request_task_resolve").handler({ ...args, taskId: 7 }, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ task: { state: "RESOLVED" } });
  });
});
