import { describe, expect, it } from "vitest";
import { testBitbucketClient } from "../../support/testClient.js";
import { route } from "../../support/fakeFetch.js";
import { userTools } from "../../../src/tools/user.js";
import { RequestContext } from "../../../src/context.js";

function tool(name: string) {
  const found = userTools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("bitbucket_whoami", () => {
  it("returns the authenticated account", async () => {
    const bitbucket = testBitbucketClient([route("GET", "/2.0/user", { status: 200, body: { uuid: "{me}", display_name: "Stan" } })]);
    const result = await tool("bitbucket_whoami").handler({}, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ user: { display_name: "Stan" } });
  });
});

describe("bitbucket_workspace_list", () => {
  it("unwraps the workspace from each workspace_access entry", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/user/workspaces", {
        status: 200,
        body: { values: [{ administrator: true, workspace: { uuid: "{w}", name: "My Team", slug: "my-team" } }] },
      }),
    ]);
    const result = await tool("bitbucket_workspace_list").handler({ maxItems: 25 }, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ workspaces: [{ slug: "my-team" }] });
    expect((result.content as { text: string }[])[0].text).toContain("(admin)");
  });

  it("falls back to slug when a real workspace has no name - confirmed live, not just theoretical", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/user/workspaces", {
        status: 200,
        body: { values: [{ administrator: false, workspace: { uuid: "{w}", slug: "no-name-workspace" } }] },
      }),
    ]);
    const result = await tool("bitbucket_workspace_list").handler({ maxItems: 25 }, { bitbucket } as RequestContext);
    expect(result.isError).toBeFalsy();
    expect((result.content as { text: string }[])[0].text).toContain("no-name-workspace - no-name-workspace");
  });
});

describe("bitbucket_workspace_member_list", () => {
  it("unwraps the user from each membership entry, giving a uuid usable in pull_request_create's reviewers", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/workspaces/my-team/members", {
        status: 200,
        body: { values: [{ user: { uuid: "{jane}", display_name: "Jane Doe" } }] },
      }),
    ]);
    const result = await tool("bitbucket_workspace_member_list").handler(
      { workspace: "my-team", maxItems: 25 },
      { bitbucket } as RequestContext,
    );
    expect(result.structuredContent).toMatchObject({ members: [{ uuid: "{jane}", display_name: "Jane Doe" }] });
  });
});

describe("bitbucket_pull_request_list_by_user", () => {
  it("resolves the configured default workspace when none is given explicitly", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/workspaces/default-ws/pullrequests/%7Bme%7D", { status: 200, body: { values: [] } }),
    ]);
    const result = await tool("bitbucket_pull_request_list_by_user").handler(
      { selectedUser: "{me}", maxItems: 25 },
      { bitbucket, defaultWorkspace: "default-ws" } as RequestContext,
    );
    expect(result.isError).toBeFalsy();
  });

  it("fails with an actionable error when no workspace is given or configured", async () => {
    const bitbucket = testBitbucketClient([]);
    const result = await tool("bitbucket_pull_request_list_by_user").handler(
      { selectedUser: "{me}", maxItems: 25 },
      { bitbucket } as RequestContext,
    );
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("bitbucket_workspace_list");
  });
});
