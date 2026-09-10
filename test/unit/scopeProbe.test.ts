import { describe, expect, it } from "vitest";
import { testBitbucketClient } from "../support/testClient.js";
import { route } from "../support/fakeFetch.js";
import { isToolAllowed, probeGrantedScopes } from "../../src/scopeProbe.js";

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

  describe("default (strictScopeFilter: false) - mode is the only gate, the probe never hides a tool", () => {
    it("allows a tool the mode permits even when the probe says the scope is missing", () => {
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "write", "readwrite", false)).toBe(true);
    });

    it("still denies whatever the mode ceiling denies, regardless of probe result", () => {
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "write", "readonly", false)).toBe(false);
      expect(isToolAllowed(unknown, "write:pullrequest:bitbucket", "draft", "readonly", false)).toBe(false);
      expect(isToolAllowed(unknown, "write:pullrequest:bitbucket", "write", "draft", false)).toBe(false);
    });
  });

  describe("strictScopeFilter: true - restores probe-based hiding on top of the mode gate", () => {
    it("allows a read tool when the known scope set contains it", () => {
      expect(isToolAllowed(known, "read:pullrequest:bitbucket", "read", "readwrite", true)).toBe(true);
    });

    it("denies a tool when the known scope set doesn't contain it", () => {
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "write", "readwrite", true)).toBe(false);
    });

    it("fails open (allows) whenever the probe is inconclusive, regardless of the tool's scope", () => {
      expect(isToolAllowed(unknown, "write:repository:bitbucket", "write", "readwrite", true)).toBe(true);
    });

    it("readonly mode denies any write or draft tool, independent of scope knowledge", () => {
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "write", "readonly", true)).toBe(false);
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "draft", "readonly", true)).toBe(false);
      expect(isToolAllowed(unknown, "write:pullrequest:bitbucket", "write", "readonly", true)).toBe(false);
    });

    it("readonly mode does not affect read tools", () => {
      expect(isToolAllowed(known, "read:pullrequest:bitbucket", "read", "readonly", true)).toBe(true);
    });

    it("draft mode allows draft tools but denies full write tools, independent of scope knowledge", () => {
      expect(isToolAllowed(known, "write:pullrequest:bitbucket", "draft", "draft", true)).toBe(false); // known doesn't have this scope
      expect(isToolAllowed(unknown, "write:pullrequest:bitbucket", "draft", "draft", true)).toBe(true); // fails open
      expect(isToolAllowed(unknown, "write:pullrequest:bitbucket", "write", "draft", true)).toBe(false); // draft mode blocks write regardless
    });

    it("draft mode does not affect read tools", () => {
      expect(isToolAllowed(known, "read:pullrequest:bitbucket", "read", "draft", true)).toBe(true);
    });
  });
});
