import { describe, expect, it } from "vitest";
import { genericConfigSnippet, mergeJsonMcpConfig, mergeOpenCodeConfig } from "../../../src/cli/agents.js";
import { EnvVars } from "../../../src/cli/agents.js";

const env: EnvVars = { BITBUCKET_API_TOKEN: "tok123", BITBUCKET_MCP_MODE: "draft" };

function servers(config: ReturnType<typeof mergeJsonMcpConfig>["config"], key: string): Record<string, unknown> {
  return config[key] as Record<string, unknown>;
}

describe("mergeJsonMcpConfig", () => {
  it("adds the bitbucket entry to an empty/missing file", () => {
    const { config, alreadyRegistered } = mergeJsonMcpConfig(undefined, "mcpServers", env);
    expect(alreadyRegistered).toBe(false);
    expect(servers(config, "mcpServers").bitbucket).toMatchObject({ command: "npx", args: ["-y", "bucket-mcp"] });
  });

  it("preserves other servers and other top-level keys already in the file", () => {
    const existing = JSON.stringify({
      mcpServers: { "some-other-tool": { command: "node", args: ["other.js"] } },
      someUnrelatedTopLevelSetting: true,
    });

    const { config, alreadyRegistered } = mergeJsonMcpConfig(existing, "mcpServers", env);

    expect(alreadyRegistered).toBe(false);
    expect(servers(config, "mcpServers")["some-other-tool"]).toEqual({ command: "node", args: ["other.js"] });
    expect(config.someUnrelatedTopLevelSetting).toBe(true);
    expect(servers(config, "mcpServers").bitbucket).toBeDefined();
  });

  it("detects an existing bitbucket entry and replaces only that one", () => {
    const existing = JSON.stringify({
      mcpServers: {
        bitbucket: { command: "npx", args: ["-y", "bucket-mcp"], env: { BITBUCKET_API_TOKEN: "old-token", BITBUCKET_MCP_MODE: "readonly" } },
        "some-other-tool": { command: "node", args: ["other.js"] },
      },
    });

    const { config, alreadyRegistered } = mergeJsonMcpConfig(existing, "mcpServers", env);

    expect(alreadyRegistered).toBe(true);
    expect(servers(config, "mcpServers")["some-other-tool"]).toEqual({ command: "node", args: ["other.js"] });
    expect((servers(config, "mcpServers").bitbucket as { env: Record<string, string> }).env.BITBUCKET_API_TOKEN).toBe("tok123");
  });

  it("starts fresh (without throwing) when the existing file has invalid JSON", () => {
    const { config, alreadyRegistered } = mergeJsonMcpConfig("{ not valid json", "mcpServers", env);
    expect(alreadyRegistered).toBe(false);
    expect(servers(config, "mcpServers").bitbucket).toBeDefined();
  });

  it("includes the optional default workspace only when set", () => {
    const { config } = mergeJsonMcpConfig(undefined, "mcpServers", { ...env, BITBUCKET_DEFAULT_WORKSPACE: "my-team" });
    expect((servers(config, "mcpServers").bitbucket as { env: Record<string, string> }).env.BITBUCKET_DEFAULT_WORKSPACE).toBe("my-team");

    const { config: withoutWorkspace } = mergeJsonMcpConfig(undefined, "mcpServers", env);
    expect((servers(withoutWorkspace, "mcpServers").bitbucket as { env: Record<string, string> }).env.BITBUCKET_DEFAULT_WORKSPACE).toBeUndefined();
  });

  it("respects a different top-level key, e.g. VS Code's \"servers\"", () => {
    const existing = JSON.stringify({ servers: { "some-other-tool": { command: "node" } } });
    const { config, alreadyRegistered } = mergeJsonMcpConfig(existing, "servers", env);

    expect(alreadyRegistered).toBe(false);
    expect(servers(config, "servers")["some-other-tool"]).toEqual({ command: "node" });
    expect(servers(config, "servers").bitbucket).toBeDefined();
    expect(config.mcpServers).toBeUndefined();
  });
});

describe("mergeOpenCodeConfig", () => {
  it("adds an entry with OpenCode's distinct shape (array command, environment key, type/enabled)", () => {
    const { config, alreadyRegistered } = mergeOpenCodeConfig(undefined, env);
    expect(alreadyRegistered).toBe(false);
    expect((config.mcp as Record<string, unknown>).bitbucket).toEqual({
      type: "local",
      command: ["npx", "-y", "bucket-mcp"],
      enabled: true,
      environment: { BITBUCKET_API_TOKEN: "tok123", BITBUCKET_MCP_MODE: "draft" },
    });
  });

  it("preserves other mcp entries and other top-level config", () => {
    const existing = JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      mcp: { "some-other-tool": { type: "local", command: ["node", "other.js"] } },
    });

    const { config, alreadyRegistered } = mergeOpenCodeConfig(existing, env);

    expect(alreadyRegistered).toBe(false);
    expect(config.$schema).toBe("https://opencode.ai/config.json");
    expect((config.mcp as Record<string, unknown>)["some-other-tool"]).toEqual({ type: "local", command: ["node", "other.js"] });
    expect((config.mcp as Record<string, unknown>).bitbucket).toBeDefined();
  });

  it("detects an existing bitbucket entry", () => {
    const existing = JSON.stringify({ mcp: { bitbucket: { type: "local", command: ["npx", "-y", "bucket-mcp"] } } });
    const { alreadyRegistered } = mergeOpenCodeConfig(existing, env);
    expect(alreadyRegistered).toBe(true);
  });
});

describe("genericConfigSnippet", () => {
  it("produces valid, parseable JSON with the standard MCP stdio server shape", () => {
    const parsed = JSON.parse(genericConfigSnippet(env));
    expect(parsed).toEqual({
      command: "npx",
      args: ["-y", "bucket-mcp"],
      env: { BITBUCKET_API_TOKEN: "tok123", BITBUCKET_MCP_MODE: "draft" },
    });
  });
});
