import { describe, expect, it } from "vitest";
import { loadConfig, resolveMode } from "../../src/config.js";

describe("resolveMode", () => {
  it("defaults to draft when nothing is set", () => {
    expect(resolveMode({})).toBe("draft");
  });

  it.each(["readonly", "draft", "readwrite"] as const)("accepts BITBUCKET_MCP_MODE=%s", (mode) => {
    expect(resolveMode({ BITBUCKET_MCP_MODE: mode })).toBe(mode);
  });

  it("is case-insensitive", () => {
    expect(resolveMode({ BITBUCKET_MCP_MODE: "ReadWrite" })).toBe("readwrite");
  });

  it("throws a clear error on an unrecognized mode", () => {
    expect(() => resolveMode({ BITBUCKET_MCP_MODE: "production" })).toThrow(/BITBUCKET_MCP_MODE must be/);
  });

  it("falls back to the legacy BITBUCKET_MCP_READONLY=1 alias", () => {
    expect(resolveMode({ BITBUCKET_MCP_READONLY: "1" })).toBe("readonly");
  });

  it("falls back to the legacy BITBUCKET_MCP_READONLY=true alias", () => {
    expect(resolveMode({ BITBUCKET_MCP_READONLY: "true" })).toBe("readonly");
  });

  it("ignores BITBUCKET_MCP_READONLY when BITBUCKET_MCP_MODE is set", () => {
    expect(resolveMode({ BITBUCKET_MCP_MODE: "readwrite", BITBUCKET_MCP_READONLY: "1" })).toBe("readwrite");
  });

  it("ignores an unrecognized BITBUCKET_MCP_READONLY value rather than treating it as readonly", () => {
    expect(resolveMode({ BITBUCKET_MCP_READONLY: "yes" })).toBe("draft");
  });
});

describe("loadConfig", () => {
  it("throws when BITBUCKET_API_TOKEN is missing", () => {
    expect(() => loadConfig({})).toThrow(/BITBUCKET_API_TOKEN is not set/);
  });

  it("reads the token, mode, and default workspace from the environment", () => {
    const config = loadConfig({
      BITBUCKET_API_TOKEN: "tok",
      BITBUCKET_MCP_MODE: "readonly",
      BITBUCKET_DEFAULT_WORKSPACE: "my-team",
    });
    expect(config).toEqual({ apiToken: "tok", mode: "readonly", defaultWorkspace: "my-team", strictScopeFilter: false });
  });

  it("leaves defaultWorkspace undefined when unset", () => {
    const config = loadConfig({ BITBUCKET_API_TOKEN: "tok" });
    expect(config.defaultWorkspace).toBeUndefined();
  });

  it("strictScopeFilter defaults to false", () => {
    expect(loadConfig({ BITBUCKET_API_TOKEN: "tok" }).strictScopeFilter).toBe(false);
  });

  it("strictScopeFilter turns on via BITBUCKET_MCP_STRICT_SCOPE_FILTER=1", () => {
    expect(loadConfig({ BITBUCKET_API_TOKEN: "tok", BITBUCKET_MCP_STRICT_SCOPE_FILTER: "1" }).strictScopeFilter).toBe(true);
  });

  it("strictScopeFilter turns on via BITBUCKET_MCP_STRICT_SCOPE_FILTER=true", () => {
    expect(loadConfig({ BITBUCKET_API_TOKEN: "tok", BITBUCKET_MCP_STRICT_SCOPE_FILTER: "true" }).strictScopeFilter).toBe(true);
  });
});
