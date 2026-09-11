import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { StaticTokenCredentialProvider } from "../../src/credentials.js";
import { Mode } from "../../src/scopeProbe.js";
import { createFakeFetch, route } from "../support/fakeFetch.js";

/**
 * Drives the real MCP wire protocol (initialize -> tools/list -> tools/call)
 * through an in-process client/server pair - no subprocess, no real
 * network, but the actual SDK request/response handling and our tool
 * registration/gating logic all run for real. Bitbucket itself is the only
 * thing faked (see test/support/fakeFetch.ts).
 */
async function connectedClient(fetchImpl: typeof fetch, mode: Mode = "readwrite", defaultWorkspace?: string, strictScopeFilter = false) {
  const server = await createServer(
    { apiToken: "test-token", mode, defaultWorkspace, strictScopeFilter },
    new StaticTokenCredentialProvider("test-token"),
    fetchImpl,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

describe("bucket-mcp server (e2e)", () => {
  it("completes the initialize handshake and lists tools", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(25);
    expect(tools.map((t) => t.name)).toContain("bitbucket_pull_request_merge");
  });

  it("by default, keeps a tool registered even when the probe says its scope is missing", async () => {
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, headers: { "x-oauth-scopes": "read:pullrequest:bitbucket" }, body: {} }),
    ]);
    const client = await connectedClient(fetchImpl, "readwrite");

    const { tools } = await client.listTools();
    // The probe found only read:pullrequest:bitbucket - write:repository:bitbucket
    // is missing, but strictScopeFilter defaults to false, so this tool stays
    // listed and a real call would surface Bitbucket's own 403 instead.
    expect(tools.map((t) => t.name)).toContain("bitbucket_branch_delete");
  });

  it("strictScopeFilter:true restores hiding a tool whose scope the probe found missing", async () => {
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, headers: { "x-oauth-scopes": "read:pullrequest:bitbucket" }, body: {} }),
    ]);
    const client = await connectedClient(fetchImpl, "readwrite", undefined, true);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain("bitbucket_branch_delete");
  });

  it("readonly mode excludes every write/draft tool, keeps read tools", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl, "readonly");

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("bitbucket_pull_request_merge");
    expect(names).not.toContain("bitbucket_branch_delete");
    expect(names).not.toContain("bitbucket_pull_request_create"); // excluded entirely, not just the write variant
    expect(names).toContain("bitbucket_pull_request_get");
  });

  it("draft mode exposes pull_request_create and comment_create but nothing that merges, approves, or edits", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl, "draft");

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("bitbucket_pull_request_create");
    expect(names).toContain("bitbucket_pull_request_comment_create");
    expect(names).toContain("bitbucket_pull_request_task_create");
    expect(names).not.toContain("bitbucket_pull_request_merge");
    expect(names).not.toContain("bitbucket_pull_request_approve");
    expect(names).not.toContain("bitbucket_pull_request_update");
    expect(names).not.toContain("bitbucket_branch_delete");
  });

  it("draft mode's pull_request_create schema has no draft parameter at all - not defaulted, genuinely absent", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl, "draft");

    const { tools } = await client.listTools();
    const createTool = tools.find((t) => t.name === "bitbucket_pull_request_create")!;
    expect(Object.keys(createTool.inputSchema.properties ?? {})).not.toContain("draft");
  });

  it("draft mode's pull_request_create always sends draft:true to Bitbucket, regardless of anything the caller passes", async () => {
    let capturedBody: unknown;
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() !== "POST" || url.pathname !== "/2.0/repositories/ws/repo/pullrequests") return undefined;
        capturedBody = JSON.parse(init!.body as string);
        return { status: 200, body: { id: 1, title: "x", state: "OPEN", draft: true } };
      },
    ]);
    const client = await connectedClient(fetchImpl, "draft");

    const result = await client.callTool({
      name: "bitbucket_pull_request_create",
      // @ts-expect-error - deliberately trying to smuggle draft:false through even though the schema doesn't declare it
      arguments: { workspace: "ws", repoSlug: "repo", title: "x", sourceBranch: "feature", draft: false },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedBody).toMatchObject({ draft: true });
  });

  it("draft mode's comment_create and task_create schemas have no pending parameter at all", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl, "draft");

    const { tools } = await client.listTools();
    const commentTool = tools.find((t) => t.name === "bitbucket_pull_request_comment_create")!;
    const taskTool = tools.find((t) => t.name === "bitbucket_pull_request_task_create")!;
    expect(Object.keys(commentTool.inputSchema.properties ?? {})).not.toContain("pending");
    expect(Object.keys(taskTool.inputSchema.properties ?? {})).not.toContain("pending");
  });

  it("draft mode's comment_create and task_create always send pending:true to Bitbucket", async () => {
    let capturedCommentBody: unknown;
    let capturedTaskBody: unknown;
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() !== "POST" || url.pathname !== "/2.0/repositories/ws/repo/pullrequests/1/comments") return undefined;
        capturedCommentBody = JSON.parse(init!.body as string);
        return { status: 200, body: { id: 1, content: { raw: "x" } } };
      },
      (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() !== "POST" || url.pathname !== "/2.0/repositories/ws/repo/pullrequests/1/tasks") return undefined;
        capturedTaskBody = JSON.parse(init!.body as string);
        return { status: 200, body: { id: 1, state: "UNRESOLVED", content: { raw: "x" } } };
      },
    ]);
    const client = await connectedClient(fetchImpl, "draft");

    const commentResult = await client.callTool({
      name: "bitbucket_pull_request_comment_create",
      // @ts-expect-error - deliberately trying to smuggle pending:false through even though the schema doesn't declare it
      arguments: { workspace: "ws", repoSlug: "repo", id: 1, body: "x", pending: false },
    });
    const taskResult = await client.callTool({
      name: "bitbucket_pull_request_task_create",
      // @ts-expect-error - deliberately trying to smuggle pending:false through even though the schema doesn't declare it
      arguments: { workspace: "ws", repoSlug: "repo", id: 1, content: "x", pending: false },
    });
    expect(commentResult.isError).toBeFalsy();
    expect(taskResult.isError).toBeFalsy();
    expect(capturedCommentBody).toMatchObject({ pending: true });
    expect(capturedTaskBody).toMatchObject({ pending: true });
  });

  it("fails open (keeps every tool) when the scope probe can't determine granted scopes", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 401, body: { type: "error", error: { message: "bad token" } } })]);
    const client = await connectedClient(fetchImpl);

    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(25);
  });

  it("round-trips a real tool call end to end and surfaces structuredContent", async () => {
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      route("GET", "/2.0/repositories/ws/repo", { status: 200, body: { uuid: "{r}", name: "repo", full_name: "ws/repo" } }),
    ]);
    const client = await connectedClient(fetchImpl);

    const result = await client.callTool({ name: "bitbucket_repository_get", arguments: { workspace: "ws", repoSlug: "repo" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ repository: { full_name: "ws/repo" } });
  });

  it("surfaces a Bitbucket API error as a Tool Execution Error, not a protocol error", async () => {
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      route("GET", "/2.0/repositories/ws/repo", {
        status: 403,
        headers: { "x-accepted-oauth-scopes": "repository" },
        body: { type: "error", error: { message: "forbidden" } },
      }),
    ]);
    const client = await connectedClient(fetchImpl);

    const result = await client.callTool({ name: "bitbucket_repository_get", arguments: { workspace: "ws", repoSlug: "repo" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("missing scope(s): [repository]");
  });

  it("lists bitbucket_whoami and bitbucket_workspace_list among the registered tools", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("bitbucket_whoami");
    expect(names).toContain("bitbucket_workspace_list");
  });

  it("resolves a configured default workspace end to end without the caller passing one", async () => {
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      route("GET", "/2.0/repositories/default-ws/repo", { status: 200, body: { uuid: "{r}", name: "repo", full_name: "default-ws/repo" } }),
    ]);
    const client = await connectedClient(fetchImpl, "readwrite", "default-ws");

    const result = await client.callTool({ name: "bitbucket_repository_get", arguments: { repoSlug: "repo" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ repository: { full_name: "default-ws/repo" } });
  });

  it("errors clearly when no workspace is given and none is configured", async () => {
    const fetchImpl = createFakeFetch([route("GET", "/2.0/user", { status: 200, body: {} })]);
    const client = await connectedClient(fetchImpl);

    const result = await client.callTool({ name: "bitbucket_repository_get", arguments: { repoSlug: "repo" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("bitbucket_workspace_list");
  });
});
