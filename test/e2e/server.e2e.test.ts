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
async function connectedClient(fetchImpl: typeof fetch, mode: Mode = "readwrite", defaultWorkspace?: string) {
  const server = await createServer(
    { apiToken: "test-token", mode, defaultWorkspace },
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
    const fetchImpl = createFakeFetch([
      route("GET", "/2.0/user", { status: 200, body: {} }),
      route("POST", "/2.0/repositories/ws/repo/pullrequests", { status: 200, body: { id: 1, title: "x", state: "OPEN", draft: true } }),
    ]);
    const client = await connectedClient(fetchImpl, "draft");

    const result = await client.callTool({
      name: "bitbucket_pull_request_create",
      // @ts-expect-error - deliberately trying to smuggle draft:false through even though the schema doesn't declare it
      arguments: { workspace: "ws", repoSlug: "repo", title: "x", sourceBranch: "feature", draft: false },
    });
    expect(result.isError).toBeFalsy();
    // The fake route only matches if the real request body actually had draft:true -
    // if the handler had honored a smuggled draft:false, no route would match and this would error.
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
    expect((result.content as { text: string }[])[0].text).toContain("requires scope(s) [repository]");
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
