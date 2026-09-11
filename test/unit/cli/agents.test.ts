import { describe, expect, it } from "vitest";
import {
  buildClaudeMcpAddArgs,
  buildCodexMcpAddArgs,
  genericConfigSnippet,
  mergeClaudeAskRules,
  mergeJsonMcpConfig,
  mergeOpenCodeAskRules,
  mergeOpenCodeConfig,
  mergePiAskRules,
  removeClaudeAskRules,
  removeFromJsonMcpConfig,
  removeOpenCodeAskRules,
} from "../../../src/cli/agents.js";
import { EnvVars } from "../../../src/cli/agents.js";

const env: EnvVars = { BITBUCKET_API_TOKEN: "tok123", BITBUCKET_MCP_MODE: "draft" };

describe("buildClaudeMcpAddArgs", () => {
  it("places the server name before every --env flag, not after", () => {
    const args = buildClaudeMcpAddArgs(env);
    const nameIndex = args.indexOf("bitbucket");
    const firstEnvFlagIndex = args.indexOf("--env");
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeLessThan(firstEnvFlagIndex);
  });

  it("never places a bare (non-KEY=VALUE) token immediately before the -- separator", () => {
    // claude's --env is variadic (`-e, --env <env...>`) and greedily
    // consumes every bare token up to the next recognized flag or `--` -
    // this is the exact shape of the live bug ("Invalid environment
    // variable format: bitbucket"): a positional sitting right before `--`
    // gets swallowed into the preceding --env's value list instead.
    const args = buildClaudeMcpAddArgs(env);
    const tokenBeforeSeparator = args[args.indexOf("--") - 1];
    expect(tokenBeforeSeparator).toContain("=");
  });

  it("includes --scope user and --transport stdio", () => {
    const args = buildClaudeMcpAddArgs(env);
    expect(args).toEqual(expect.arrayContaining(["--scope", "user", "--transport", "stdio"]));
  });

  it("ends with -- npx -y bucket-mcp", () => {
    const args = buildClaudeMcpAddArgs(env);
    expect(args.slice(-4)).toEqual(["--", "npx", "-y", "bucket-mcp"]);
  });
});

describe("buildCodexMcpAddArgs", () => {
  it("places the server name before every --env flag, not after", () => {
    const args = buildCodexMcpAddArgs(env);
    const nameIndex = args.indexOf("bitbucket");
    const firstEnvFlagIndex = args.indexOf("--env");
    expect(nameIndex).toBeGreaterThanOrEqual(0);
    expect(nameIndex).toBeLessThan(firstEnvFlagIndex);
  });

  it("ends with -- npx -y bucket-mcp", () => {
    const args = buildCodexMcpAddArgs(env);
    expect(args.slice(-4)).toEqual(["--", "npx", "-y", "bucket-mcp"]);
  });
});

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

  it("omits \"type\" entirely when entryType isn't given (Cursor, Pi)", () => {
    const { config } = mergeJsonMcpConfig(undefined, "mcpServers", env);
    expect(servers(config, "mcpServers").bitbucket).not.toHaveProperty("type");
  });

  it('sets "type": "stdio" for VS Code\'s required discriminator', () => {
    const { config } = mergeJsonMcpConfig(undefined, "servers", env, "stdio");
    expect((servers(config, "servers").bitbucket as { type: string }).type).toBe("stdio");
  });

  it('sets "type": "local" for standalone Copilot CLI\'s required discriminator', () => {
    const { config } = mergeJsonMcpConfig(undefined, "mcpServers", env, "local");
    expect((servers(config, "mcpServers").bitbucket as { type: string }).type).toBe("local");
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

const writeTools = ["bitbucket_pull_request_merge", "bitbucket_branch_delete"];

describe("mergeClaudeAskRules", () => {
  it("adds mcp__bitbucket__<tool> ask rules for each write tool", () => {
    const config = mergeClaudeAskRules({}, writeTools);
    expect(config.permissions).toEqual({ ask: ["mcp__bitbucket__bitbucket_pull_request_merge", "mcp__bitbucket__bitbucket_branch_delete"] });
  });

  it("preserves existing permissions and other top-level settings, and dedupes", () => {
    const existing = {
      someOtherSetting: true,
      permissions: { ask: ["mcp__bitbucket__bitbucket_pull_request_merge", "mcp__other-server__some_tool"], allow: ["Bash(git status)"] },
    };
    const config = mergeClaudeAskRules(existing, writeTools);
    expect(config.someOtherSetting).toBe(true);
    expect((config.permissions as { allow: string[] }).allow).toEqual(["Bash(git status)"]);
    const ask = (config.permissions as { ask: string[] }).ask;
    expect(ask).toContain("mcp__other-server__some_tool");
    expect(ask.filter((r) => r === "mcp__bitbucket__bitbucket_pull_request_merge")).toHaveLength(1);
  });
});

describe("mergeOpenCodeAskRules", () => {
  it("sets each write tool to \"ask\" by bare tool name, no server prefix", () => {
    const config = mergeOpenCodeAskRules({}, writeTools);
    expect(config.permission).toEqual({ bitbucket_pull_request_merge: "ask", bitbucket_branch_delete: "ask" });
  });

  it("preserves existing permission entries for other tools", () => {
    const existing = { permission: { bash: "allow", edit: "ask" } };
    const config = mergeOpenCodeAskRules(existing, writeTools);
    expect(config.permission).toEqual({ bash: "allow", edit: "ask", bitbucket_pull_request_merge: "ask", bitbucket_branch_delete: "ask" });
  });
});

describe("mergePiAskRules", () => {
  it("sets approveTools on the bitbucket server entry, preserving its other fields", () => {
    const existing = { mcpServers: { bitbucket: { command: "npx", args: ["-y", "bucket-mcp"], env: { X: "1" } } } };
    const config = mergePiAskRules(existing, writeTools);
    const bitbucketEntry = (config.mcpServers as Record<string, unknown>).bitbucket as Record<string, unknown>;
    expect(bitbucketEntry.approveTools).toEqual(writeTools);
    expect(bitbucketEntry.command).toBe("npx");
  });

  it("preserves other servers in mcpServers", () => {
    const existing = { mcpServers: { "some-other-tool": { command: "node" } } };
    const config = mergePiAskRules(existing, writeTools);
    expect((config.mcpServers as Record<string, unknown>)["some-other-tool"]).toEqual({ command: "node" });
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

describe("removeFromJsonMcpConfig", () => {
  it("removes the bitbucket entry and reports found:true", () => {
    const existing = { mcpServers: { bitbucket: { command: "npx" }, "some-other-tool": { command: "node" } } };
    const { config, found } = removeFromJsonMcpConfig(existing, "mcpServers");
    expect(found).toBe(true);
    expect((config.mcpServers as Record<string, unknown>).bitbucket).toBeUndefined();
    expect((config.mcpServers as Record<string, unknown>)["some-other-tool"]).toEqual({ command: "node" });
  });

  it("reports found:false and leaves the config untouched when there's nothing to remove", () => {
    const existing = { mcpServers: { "some-other-tool": { command: "node" } } };
    const { config, found } = removeFromJsonMcpConfig(existing, "mcpServers");
    expect(found).toBe(false);
    expect(config).toBe(existing);
  });

  it("reports found:false when the top-level key itself is absent", () => {
    const { found } = removeFromJsonMcpConfig({}, "mcpServers");
    expect(found).toBe(false);
  });
});

describe("removeClaudeAskRules", () => {
  it("removes only mcp__bitbucket__* rules, keeping unrelated ask rules", () => {
    const existing = {
      permissions: { ask: ["mcp__bitbucket__bitbucket_pull_request_merge", "mcp__other-server__some_tool"], allow: ["Bash(git status)"] },
    };
    const { config, found } = removeClaudeAskRules(existing);
    expect(found).toBe(true);
    expect((config.permissions as { ask: string[] }).ask).toEqual(["mcp__other-server__some_tool"]);
    expect((config.permissions as { allow: string[] }).allow).toEqual(["Bash(git status)"]);
  });

  it("reports found:false when there are no bitbucket ask rules", () => {
    const existing = { permissions: { ask: ["mcp__other-server__some_tool"] } };
    const { found } = removeClaudeAskRules(existing);
    expect(found).toBe(false);
  });

  it("reports found:false when there's no permissions.ask at all", () => {
    expect(removeClaudeAskRules({}).found).toBe(false);
  });
});

describe("removeOpenCodeAskRules", () => {
  it("removes only bitbucket_-prefixed tool entries, keeping unrelated permission entries", () => {
    const existing = { permission: { bash: "allow", bitbucket_pull_request_merge: "ask", bitbucket_branch_delete: "ask" } };
    const { config, found } = removeOpenCodeAskRules(existing);
    expect(found).toBe(true);
    expect(config.permission).toEqual({ bash: "allow" });
  });

  it("reports found:false when there are no bitbucket_ entries", () => {
    const existing = { permission: { bash: "allow" } };
    expect(removeOpenCodeAskRules(existing).found).toBe(false);
  });
});
