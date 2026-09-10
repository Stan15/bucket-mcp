import { describe, expect, it } from "vitest";
import { testBitbucketClient } from "../test/support/testClient.js";
import { route } from "../test/support/fakeFetch.js";
import { isToolAllowed, probeGrantedScopes } from "./scopeProbe.js";

describe("probeGrantedScopes", () => {
  it("parses a comma-separated x-oauth-scopes header into a set", async () => {
    const client = testBitbucketClient([
      route("GET", "/2.0/user", { status: 200, headers: { "x-oauth-scopes": "read:pullrequest:bitbucket, write:repository:bitbucket" }, body: { uuid: "u", display_name: "Test" } }),
    ]);
    const result = await probeGrantedScopes(client);
    expect(result).toEqual({ kind: "known", scopes: new Set(["read:pullrequest:bitbucket", "write:repository:bitbucket"]) });
  });

  it("fails open when the header is absent", async () => {
    const client = testBitbucketClient([route("GET", "/2.0/user", { status: 200, body: { uuid: "u", display_name: "Test" } })]);
    await expect(probeGrantedScopes(client)).resolves.toEqual({ kind: "unknown" });
  });

  it("fails open when the probe call itself throws (network error, invalid credential, etc.)", async () => {
    const client = testBitbucketClient([route("GET", "/2.0/user", { status: 401, body: { type: "error", error: { message: "invalid token" } } })]);
    await expect(probeGrantedScopes(client)).resolves.toEqual({ kind: "unknown" });
  });
});

describe("isToolAllowed", () => {
  const known = { kind: "known" as const, scopes: new Set(["read:pullrequest:bitbucket"]) };
  const unknown = { kind: "unknown" as const };

  it("allows a read tool when the known scope set contains it", () => {
    expect(isToolAllowed(known, "read:pullrequest:bitbucket", false, false)).toBe(true);
  });

  it("denies a tool when the known scope set doesn't contain it", () => {
    expect(isToolAllowed(known, "write:pullrequest:bitbucket", true, false)).toBe(false);
  });

  it("fails open (allows) whenever the probe is inconclusive, regardless of the tool's scope", () => {
    expect(isToolAllowed(unknown, "write:repository:bitbucket", true, false)).toBe(true);
  });

  it("readOnly denies any write/destructive tool independent of scope knowledge", () => {
    expect(isToolAllowed(known, "read:pullrequest:bitbucket", true, true)).toBe(false);
    expect(isToolAllowed(unknown, "read:pullrequest:bitbucket", true, true)).toBe(false);
  });

  it("readOnly does not affect non-destructive tools", () => {
    expect(isToolAllowed(known, "read:pullrequest:bitbucket", false, true)).toBe(true);
  });
});
