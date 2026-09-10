import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { testBitbucketClient } from "../../support/testClient.js";
import { route } from "../../support/fakeFetch.js";
import { BitbucketApiError, BitbucketClient } from "../../../src/bitbucket/client.js";
import { StaticTokenCredentialProvider } from "../../../src/credentials.js";

describe("BitbucketClient error mapping", () => {
  it("includes both granted and accepted scopes in a 403 message", async () => {
    const client = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo", {
        status: 403,
        headers: { "x-accepted-oauth-scopes": "write:pullrequest:bitbucket", "x-oauth-scopes": "read:pullrequest:bitbucket" },
        body: { type: "error", error: { message: "Your credentials lack one or more required privilege scopes." } },
      }),
    ]);

    await expect(client.get("/repositories/ws/repo")).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("this credential has scope(s) [read:pullrequest:bitbucket], this operation requires [write:pullrequest:bitbucket]"),
    });
  });

  it("falls back to just the required scope when the granted-scope header is absent", async () => {
    const client = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo", {
        status: 403,
        headers: { "x-accepted-oauth-scopes": "repository" },
        body: { type: "error", error: { message: "forbidden" } },
      }),
    ]);

    const error = await client.get("/repositories/ws/repo").catch((e) => e);
    expect(error.message).toContain("this operation requires scope(s) [repository]");
    expect(error.message).not.toContain("this credential has");
  });

  it("surfaces Retry-After on a 429", async () => {
    const client = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo", {
        status: 429,
        headers: { "retry-after": "42" },
        body: { type: "error", error: { message: "Rate limit exceeded" } },
      }),
    ]);

    await expect(client.get("/repositories/ws/repo")).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: "42",
      message: expect.stringContaining("retry after 42s"),
    });
  });

  it("still produces a usable error when the response body isn't JSON", async () => {
    const client = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo", { status: 500, body: "<html>gateway error</html>" })]);

    await expect(client.get("/repositories/ws/repo")).rejects.toBeInstanceOf(BitbucketApiError);
  });
});

describe("BitbucketClient body handling", () => {
  it("returns undefined for a 204", async () => {
    const client = testBitbucketClient([route("DELETE", "/2.0/repositories/ws/repo/refs/branches/foo", { status: 204 })]);
    await expect(client.delete("/repositories/ws/repo/refs/branches/foo")).resolves.toBeUndefined();
  });

  it("returns undefined for a 2xx with an empty body (e.g. merge's 202)", async () => {
    const client = testBitbucketClient([
      route("POST", "/2.0/repositories/ws/repo/pullrequests/1/merge", { status: 202, headers: { location: "https://api.bitbucket.org/2.0/.../task-status/abc" } }),
    ]);
    const { body, response } = await client.postWithResponse("/repositories/ws/repo/pullrequests/1/merge");
    expect(response.status).toBe(202);
    expect(body).toBeUndefined();
    expect(response.headers.get("location")).toContain("task-status/abc");
  });

  it("returns raw text for a non-JSON content type", async () => {
    const client = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo/diff/abc", { status: 200, body: "diff --git a/x b/x\n" })]);
    await expect(client.get("/repositories/ws/repo/diff/abc")).resolves.toBe("diff --git a/x b/x\n");
  });

  it("validates a response body against a provided Zod schema", async () => {
    const schema = z.object({ hash: z.string() });
    const client = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo/commit/abc", { status: 200, body: { hash: "abc123" } })]);
    await expect(client.get("/repositories/ws/repo/commit/abc", undefined, schema)).resolves.toEqual({ hash: "abc123" });
  });

  it("throws when the response doesn't match the provided schema", async () => {
    const schema = z.object({ hash: z.string() });
    const client = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo/commit/abc", { status: 200, body: { wrong_field: "abc123" } })]);
    await expect(client.get("/repositories/ws/repo/commit/abc", undefined, schema)).rejects.toThrow();
  });
});

describe("BitbucketClient.paginate", () => {
  it("follows `next` across pages and validates each item", async () => {
    const itemSchema = z.object({ id: z.number() });
    const client = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/pullrequests", {
        status: 200,
        body: { values: [{ id: 1 }, { id: 2 }], next: "https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?page=2" },
      }),
      route("GET", "/2.0/repositories/ws/repo/pullrequests", { status: 200, body: { values: [{ id: 3 }] } }),
    ]);

    const { values, hasMore } = await client.paginate("/repositories/ws/repo/pullrequests", undefined, 50, itemSchema);
    expect(values).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(hasMore).toBe(false);
  });

  it("stops at maxItems and reports hasMore even mid-page", async () => {
    const client = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/pullrequests", {
        status: 200,
        body: { values: [{ id: 1 }, { id: 2 }, { id: 3 }], next: "https://api.bitbucket.org/2.0/next" },
      }),
    ]);

    const { values, hasMore } = await client.paginate("/repositories/ws/repo/pullrequests", undefined, 2);
    expect(values).toHaveLength(2);
    expect(hasMore).toBe(true);
  });
});

describe("BitbucketClient request timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts a hung request and throws a clear, actionable error instead of hanging forever", async () => {
    vi.useFakeTimers();
    // A fetch stub that honors AbortSignal, the way the real global fetch does - never
    // resolves on its own, only rejects once the client's own timeout fires the signal.
    const hangingFetch = ((_url: URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }) as typeof fetch;

    const client = new BitbucketClient(new StaticTokenCredentialProvider("test-token"), hangingFetch);
    const promise = client.get("/repositories/ws/repo");
    const assertion = expect(promise).rejects.toMatchObject({
      message: expect.stringContaining("timed out after 30s"),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("clears its timeout on a normal response - no pending timer left behind to keep the process alive", async () => {
    vi.useFakeTimers();
    const client = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo", { status: 200, body: { uuid: "{r}" } })]);
    await client.get("/repositories/ws/repo");
    expect(vi.getTimerCount()).toBe(0);
  });
});
