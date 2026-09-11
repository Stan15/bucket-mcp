import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import * as p from "@clack/prompts";
import { Mode } from "../scopeProbe.js";
import { writeOperationToolNames } from "../tools/allTools.js";
import { SERVER_NAME } from "./constants.js";

const execFileAsync = promisify(execFile);

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** VS Code's per-OS user-profile config directory (distinct from a workspace's .vscode/). */
function vsCodeUserDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "Code", "User");
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Code", "User");
  return join(homedir(), ".config", "Code", "User");
}

export interface EnvVars {
  BITBUCKET_API_TOKEN: string;
  BITBUCKET_DEFAULT_WORKSPACE?: string;
  BITBUCKET_MCP_MODE: Mode;
}

function envEntries(env: EnvVars): [string, string][] {
  const entries: [string, string][] = [["BITBUCKET_API_TOKEN", env.BITBUCKET_API_TOKEN]];
  if (env.BITBUCKET_DEFAULT_WORKSPACE) entries.push(["BITBUCKET_DEFAULT_WORKSPACE", env.BITBUCKET_DEFAULT_WORKSPACE]);
  entries.push(["BITBUCKET_MCP_MODE", env.BITBUCKET_MCP_MODE]);
  return entries;
}

function redact(args: string[]): string[] {
  return args.map((a) => (a.startsWith("BITBUCKET_API_TOKEN=") ? "BITBUCKET_API_TOKEN=***" : a));
}

/**
 * The generic, standard MCP stdio-server config block - the shape almost
 * every MCP client's config file wraps in some client-specific envelope
 * (a top-level key name, a scope selector, etc.). Shown verbatim for
 * "my agent isn't listed" and for any client this file doesn't have
 * dedicated support for.
 */
export function genericConfigSnippet(env: EnvVars): string {
  const envObject: Record<string, string> = Object.fromEntries(envEntries(env));
  return JSON.stringify({ command: "npx", args: ["-y", "bucket-mcp"], env: envObject }, null, 2);
}

export type AgentId = "claude" | "codex" | "cursor" | "copilot" | "pi" | "opencode" | "other";

export const AGENT_OPTIONS: { value: AgentId; label: string; hint?: string }[] = [
  { value: "claude", label: "Claude Code", hint: "registers automatically via `claude mcp add`" },
  { value: "codex", label: "Codex CLI", hint: "registers automatically via `codex mcp add`" },
  { value: "cursor", label: "Cursor", hint: "writes ~/.cursor/mcp.json automatically" },
  { value: "copilot", label: "GitHub Copilot", hint: "registers automatically once it knows which surface you use" },
  { value: "pi", label: "Pi Agent", hint: "registers automatically in the common case" },
  { value: "opencode", label: "OpenCode", hint: "writes ~/.config/opencode/opencode.json automatically" },
  { value: "other", label: "My agent isn't listed", hint: "shows the standard MCP config block to paste yourself" },
];

export async function pickAgent(): Promise<AgentId> {
  const chosen = await p.autocomplete({
    message: "Which agent do you want to configure this for?",
    options: AGENT_OPTIONS,
    placeholder: "Type to search...",
  });
  if (p.isCancel(chosen)) {
    p.cancel("Cancelled - nothing was changed.");
    process.exit(0);
  }
  return chosen as AgentId;
}

/** `claude mcp get <name>` exits non-zero when nothing by that name is registered - same convention codex mcp get follows. */
async function existsViaGet(bin: string, name: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ["mcp", "get", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * SERVER_NAME must come before any --env flag: claude's --env is a
 * variadic option (`-e, --env <env...>`) that greedily swallows every
 * bare token after it up to the next recognized flag or `--` - a bare
 * name placed right before `--` gets absorbed into the last --env's
 * value list instead of parsed as the positional <name>. Confirmed live:
 * this exact bug produced "Invalid environment variable format: bitbucket".
 * A pure function so this ordering has a real test, not just eyeballing -
 * this exact bug went unnoticed for the entire session because every
 * `claude mcp add` verification was a hand-typed command with correct
 * ordering, never the wizard's own generated array run for real.
 */
export function buildClaudeMcpAddArgs(env: EnvVars): string[] {
  const args = ["mcp", "add", SERVER_NAME, "--scope", "user", "--transport", "stdio"];
  for (const [key, value] of envEntries(env)) args.push("--env", `${key}=${value}`);
  args.push("--", "npx", "-y", "bucket-mcp");
  return args;
}

export async function registerClaudeCode(env: EnvVars, alreadyRegistered: boolean, userDisplayName: string): Promise<void> {
  const args = buildClaudeMcpAddArgs(env);

  p.note(`claude ${redact(args).join(" ")}`, alreadyRegistered ? "About to run (replacing your existing setup)" : "About to run");

  const proceed = await p.confirm({
    message: alreadyRegistered ? "Replace your existing Bitbucket setup with this configuration?" : "Register this with Claude Code now?",
    initialValue: true,
  });
  if (p.isCancel(proceed)) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }
  if (!proceed) {
    p.outro("Skipped - nothing was changed. Fix whatever needs fixing and run `npx bucket-mcp configure` again, or run the command above yourself (with the real token, not the *** version).");
    return;
  }

  const spinner = p.spinner();
  spinner.start(alreadyRegistered ? "Updating existing registration" : "Running claude mcp add");
  try {
    // `claude mcp add` errors on a name that's already registered rather than
    // overwriting it, so a reconfigure has to remove the old one first.
    if (alreadyRegistered) await execFileAsync("claude", ["mcp", "remove", SERVER_NAME]);
    const { stderr } = await execFileAsync("claude", args);
    spinner.stop(alreadyRegistered ? "Updated" : "Registered with Claude Code");
    if (stderr.trim()) p.log.warn(stderr.trim());
    await offerAskEnforcement(env.BITBUCKET_MCP_MODE, "Claude Code", applyClaudeAskRules);
    p.outro(`Restart Claude Code - the Bitbucket tools will be available in every project as ${userDisplayName}.`);
  } catch (error) {
    spinner.error("Couldn't run 'claude' automatically");
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro("Run the command above yourself instead (with the real token, not the *** version).");
  }
}

/** Name comes before --env here too, for the same variadic-swallowing reason as buildClaudeMcpAddArgs. */
export function buildCodexMcpAddArgs(env: EnvVars): string[] {
  const args = ["mcp", "add", SERVER_NAME];
  for (const [key, value] of envEntries(env)) args.push("--env", `${key}=${value}`);
  args.push("--", "npx", "-y", "bucket-mcp");
  return args;
}

/**
 * Codex CLI's `mcp add/get/remove` commands mirror Claude Code's closely
 * enough (per OpenAI's own docs) to reuse the same remove-then-add pattern -
 * not hands-on verified against a live Codex install the way the Claude
 * Code path is, since this environment's own `codex` binary is an unrelated
 * legacy tool with no `mcp` subcommand at all. If this drifts from what a
 * current Codex CLI actually accepts, that's the first place to check.
 */
export async function registerCodex(env: EnvVars): Promise<void> {
  const alreadyRegistered = await existsViaGet("codex", SERVER_NAME);
  const args = buildCodexMcpAddArgs(env);

  p.note(`codex ${redact(args).join(" ")}`, alreadyRegistered ? "About to run (replacing your existing setup)" : "About to run");

  const proceed = await p.confirm({
    message: alreadyRegistered ? "Replace your existing Bitbucket setup with this configuration?" : "Register this with Codex CLI now?",
    initialValue: true,
  });
  if (p.isCancel(proceed)) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }
  if (!proceed) {
    p.outro("Skipped - nothing was changed. Fix whatever needs fixing and run `npx bucket-mcp configure` again, or run the command above yourself.");
    return;
  }

  const spinner = p.spinner();
  spinner.start(alreadyRegistered ? "Updating existing registration" : "Running codex mcp add");
  try {
    if (alreadyRegistered) await execFileAsync("codex", ["mcp", "remove", SERVER_NAME]);
    await execFileAsync("codex", args);
    spinner.stop(alreadyRegistered ? "Updated" : "Registered with Codex CLI");
    p.outro("Restart Codex CLI - the Bitbucket tools will be available.");
  } catch (error) {
    spinner.error("Couldn't run 'codex' automatically");
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro("Run the command above yourself instead.");
  }
}

export interface JsonMcpConfig {
  [topLevelKey: string]: Record<string, unknown> | unknown;
}

/**
 * Pure merge step, kept separate from the fs/prompt side effects so it has
 * real unit tests - every one of these writes to a config file a person
 * almost certainly has other tools configured in, so "does this actually
 * preserve everything else" needs to be verified, not eyeballed. `topLevelKey`
 * varies by client (Cursor/Copilot-CLI/Pi use "mcpServers", VS Code's own
 * mcp.json uses "servers"). `entryType`, when given, adds a required "type"
 * discriminator some clients need and others reject/ignore - confirmed
 * against each client's own official docs: VS Code requires
 * `"type": "stdio"`, standalone Copilot CLI requires `"type": "local"`;
 * Cursor and Pi's adapter need no "type" field at all (command's presence
 * alone means stdio).
 */
export function mergeJsonMcpConfig(
  existingRawJson: string | undefined,
  topLevelKey: string,
  env: EnvVars,
  entryType?: string,
): { config: JsonMcpConfig; alreadyRegistered: boolean } {
  let config: JsonMcpConfig = {};
  if (existingRawJson !== undefined) {
    try {
      config = JSON.parse(existingRawJson);
    } catch {
      config = {};
    }
  }
  const servers = (config[topLevelKey] as Record<string, unknown> | undefined) ?? {};
  const alreadyRegistered = Boolean(servers[SERVER_NAME]);
  const newEntry = {
    ...(entryType ? { type: entryType } : {}),
    command: "npx",
    args: ["-y", "bucket-mcp"],
    env: Object.fromEntries(envEntries(env)),
  };
  return { config: { ...config, [topLevelKey]: { ...servers, [SERVER_NAME]: newEntry } }, alreadyRegistered };
}

/**
 * Shared read-parse-confirm-write flow behind every file-based agent below.
 * `merge` gets the raw existing file content (undefined if there was none)
 * and returns the full new file content plus whether this replaces an
 * existing Bitbucket entry - kept generic over the merge step since
 * OpenCode's entry shape (command as an array, an "environment" key, a
 * required "type"/"enabled") differs enough from the command/args/env
 * shape everything else here uses that forcing it through the same
 * key-only merge would be more confusing than two small merge functions.
 */
/**
 * Returns whether the write actually happened - callers that offer a
 * follow-up step (e.g. enforcing "ask" permission rules) need to know
 * before deciding whether to ask it, and the caller owns the final outro
 * either way so a follow-up step can land between "written" and "restart".
 */
async function writeJsonMcpConfig(
  configPath: string,
  merge: (existingRawJson: string | undefined) => { config: unknown; alreadyRegistered: boolean },
  displaySnippet: string,
  agentLabel: string,
): Promise<boolean> {
  let existingRawJson: string | undefined;
  try {
    existingRawJson = await readFile(configPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
  }
  if (existingRawJson !== undefined) {
    try {
      JSON.parse(existingRawJson);
    } catch {
      p.log.warn(`Couldn't parse the existing ${configPath} - it may have invalid JSON. Starting fresh rather than risk overwriting something unreadable.`);
    }
  }

  const { config, alreadyRegistered } = merge(existingRawJson);

  p.note(displaySnippet, `About to write to ${configPath}${alreadyRegistered ? " (replacing your existing entry)" : ""}`);

  const proceed = await p.confirm({
    message: alreadyRegistered ? "Replace your existing Bitbucket entry in this file?" : `Write this to your ${agentLabel} config now?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) {
    if (p.isCancel(proceed)) p.cancel("Cancelled - nothing was changed.");
    else p.outro("Skipped - nothing was changed. Run `npx bucket-mcp configure` again when ready, or paste the block above into that file yourself.");
    return false;
  }

  const spinner = p.spinner();
  spinner.start(`Writing ${configPath}`);
  try {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    spinner.stop("Written");
    return true;
  } catch (error) {
    spinner.error("Couldn't write the config file");
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(`Paste the block above into ${configPath} yourself.`);
    return false;
  }
}

/**
 * Offered only for agents whose own docs confirm an explicit "ask" rule
 * survives that agent's most permissive/auto-approve mode (Claude Code,
 * OpenCode, Pi) - see the write-up in conversation for Cursor (allowlist
 * only, "not a security guarantee" per its own docs) and Copilot (binary
 * allow/deny, no ask tier for the standalone CLI) not qualifying. Skipped
 * entirely in readonly mode, where there's nothing to protect.
 */
async function offerAskEnforcement(mode: Mode, agentLabel: string, apply: (writeToolNames: string[]) => Promise<void>): Promise<void> {
  const writeTools = writeOperationToolNames(mode);
  if (writeTools.length === 0) return;
  const proceed = await p.confirm({
    message: `Also force ${agentLabel} to always ask permission before running any of this server's ${writeTools.length} write operation(s), even in an auto-approve mode?`,
    initialValue: true,
  });
  if (p.isCancel(proceed) || !proceed) return;
  await apply(writeTools);
}

async function readJsonIfParseable(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") throw error;
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    p.log.warn(`Couldn't parse ${path} - leaving it untouched.`);
    return undefined;
  }
}

/**
 * Pure merge steps for the three "ask enforcement" targets, kept separate
 * from fs I/O for the same reason as mergeJsonMcpConfig/mergeCursorConfig -
 * these determine whether the actual guarantee holds, so they need real
 * tests, not eyeballing. Claude tool identifiers compose as
 * mcp__<server>__<tool-name>; OpenCode's permission config takes bare tool
 * names; Pi's approveTools is a per-server array alongside its own
 * command/args/env.
 */
export function mergeClaudeAskRules(config: Record<string, unknown>, writeToolNames: string[]): Record<string, unknown> {
  const permissions = (config.permissions as { ask?: string[] } | undefined) ?? {};
  const askRules = new Set(permissions.ask ?? []);
  for (const name of writeToolNames) askRules.add(`mcp__${SERVER_NAME}__${name}`);
  return { ...config, permissions: { ...permissions, ask: [...askRules] } };
}

export function mergeOpenCodeAskRules(config: Record<string, unknown>, writeToolNames: string[]): Record<string, unknown> {
  const permission = (config.permission as Record<string, string> | undefined) ?? {};
  const merged = { ...permission };
  for (const name of writeToolNames) merged[name] = "ask";
  return { ...config, permission: merged };
}

export function mergePiAskRules(config: Record<string, unknown>, writeToolNames: string[]): Record<string, unknown> {
  const mcpServers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
  const bitbucketEntry = (mcpServers[SERVER_NAME] as Record<string, unknown> | undefined) ?? {};
  return { ...config, mcpServers: { ...mcpServers, [SERVER_NAME]: { ...bitbucketEntry, approveTools: writeToolNames } } };
}

async function applyClaudeAskRules(writeToolNames: string[]): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  const existing = await readJsonIfParseable(settingsPath);
  if (existing === undefined) return;
  const config = mergeClaudeAskRules(existing, writeToolNames);
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  p.log.success(`Added ${writeToolNames.length} "ask" rule(s) to ${settingsPath}.`);
}

async function applyOpenCodeAskRules(writeToolNames: string[]): Promise<void> {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  const existing = await readJsonIfParseable(configPath);
  if (existing === undefined) return;
  const config = mergeOpenCodeAskRules(existing, writeToolNames);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  p.log.success(`Set ${writeToolNames.length} tool(s) to "ask" in ${configPath}'s permission config.`);
}

async function applyPiAskRules(configPath: string, writeToolNames: string[]): Promise<void> {
  const existing = await readJsonIfParseable(configPath);
  if (existing === undefined) return;
  const config = mergePiAskRules(existing, writeToolNames);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  p.log.success(`Set approveTools for ${writeToolNames.length} tool(s) in ${configPath}.`);
}

/**
 * Cursor has one well-documented, stable config path and JSON schema
 * (~/.cursor/mcp.json, {"mcpServers": {...}}) and no CLI of its own - a
 * read-merge-write is the "guaranteed" equivalent of `claude mcp add` here.
 */
export async function registerCursor(env: EnvVars): Promise<void> {
  const written = await writeJsonMcpConfig(
    join(homedir(), ".cursor", "mcp.json"),
    (existing) => mergeJsonMcpConfig(existing, "mcpServers", env),
    genericConfigSnippet(env),
    "Cursor",
  );
  if (written) p.outro("Restart Cursor - the Bitbucket tools will be available in every project.");
}

/**
 * OpenCode's own `opencode mcp add` is interactive-only (no flags to script
 * it), but its config lives at one well-documented, stable global path with
 * a clearly documented schema - same "guaranteed" bar as Cursor, just a
 * different entry shape: command is an array (not command+args split),
 * env vars live under "environment" (not "env"), and each entry needs
 * "type": "local" and "enabled": true.
 */
export function mergeOpenCodeConfig(existingRawJson: string | undefined, env: EnvVars): { config: Record<string, unknown>; alreadyRegistered: boolean } {
  let config: Record<string, unknown> = {};
  if (existingRawJson !== undefined) {
    try {
      config = JSON.parse(existingRawJson);
    } catch {
      config = {};
    }
  }
  const mcp = (config.mcp as Record<string, unknown> | undefined) ?? {};
  const alreadyRegistered = Boolean(mcp[SERVER_NAME]);
  const newEntry = { type: "local", command: ["npx", "-y", "bucket-mcp"], enabled: true, environment: Object.fromEntries(envEntries(env)) };
  return { config: { ...config, mcp: { ...mcp, [SERVER_NAME]: newEntry } }, alreadyRegistered };
}

export async function registerOpenCode(env: EnvVars): Promise<void> {
  const configPath = join(homedir(), ".config", "opencode", "opencode.json");
  const snippet = JSON.stringify(
    { type: "local", command: ["npx", "-y", "bucket-mcp"], enabled: true, environment: Object.fromEntries(envEntries(env)) },
    null,
    2,
  );
  const written = await writeJsonMcpConfig(configPath, (existing) => mergeOpenCodeConfig(existing, env), snippet, "OpenCode");
  if (!written) return;
  await offerAskEnforcement(env.BITBUCKET_MCP_MODE, "OpenCode", applyOpenCodeAskRules);
  p.outro("Restart OpenCode - the Bitbucket tools will be available.");
}

/**
 * GitHub Copilot's MCP config has exactly two well-documented, stable
 * targets - standalone Copilot CLI's ~/.copilot/mcp-config.json ("mcpServers")
 * and VS Code's own per-OS user-profile mcp.json ("servers", distinct from a
 * workspace's .vscode/mcp.json). The only real uncertainty is which one a
 * given person uses, which is detectable: check which file already exists
 * and write to that one; only ask when both or neither do.
 */
export async function registerCopilot(env: EnvVars): Promise<void> {
  const cliPath = join(homedir(), ".copilot", "mcp-config.json");
  const vscodePath = join(vsCodeUserDir(), "mcp.json");
  const [cliExists, vscodeExists] = await Promise.all([fileExists(cliPath), fileExists(vscodePath)]);

  // type differs by surface - confirmed against each one's own official
  // docs: standalone Copilot CLI requires "type": "local", VS Code's own
  // mcp.json requires "type": "stdio". Neither accepts the other's value.
  let target: { path: string; key: string; label: string; type: string };
  if (cliExists && !vscodeExists) {
    target = { path: cliPath, key: "mcpServers", label: "Copilot CLI", type: "local" };
  } else if (vscodeExists && !cliExists) {
    target = { path: vscodePath, key: "servers", label: "VS Code", type: "stdio" };
  } else {
    const choice = await p.select({
      message: cliExists && vscodeExists ? "Found config for both - which one do you want to update?" : "Which Copilot surface do you use?",
      options: [
        { value: "cli" as const, label: "Standalone Copilot CLI", hint: cliPath },
        { value: "vscode" as const, label: "VS Code (Copilot Chat)", hint: vscodePath },
      ],
    });
    if (p.isCancel(choice)) {
      p.cancel("Cancelled - nothing was changed.");
      return;
    }
    target =
      choice === "cli" ? { path: cliPath, key: "mcpServers", label: "Copilot CLI", type: "local" } : { path: vscodePath, key: "servers", label: "VS Code", type: "stdio" };
  }

  const snippet = JSON.stringify({ type: target.type, command: "npx", args: ["-y", "bucket-mcp"], env: Object.fromEntries(envEntries(env)) }, null, 2);
  const written = await writeJsonMcpConfig(target.path, (existing) => mergeJsonMcpConfig(existing, target.key, env, target.type), snippet, target.label);
  if (written) p.outro(`Restart ${target.label} - the Bitbucket tools will be available.`);
}

const PI_GLOBAL_CANDIDATES = [join(homedir(), ".config", "mcp", "mcp.json"), join(homedir(), ".agents", "mcp.json"), join(homedir(), ".agents", "mcp", "mcp.json")];

/**
 * Pi's MCP support (via the third-party pi-mcp-adapter) checks several
 * layered config paths with no reliable non-interactive add command, so
 * there's no single "the" path the way Cursor has one - but real evidence
 * still narrows it: if exactly one of the known global paths already
 * exists, that's almost certainly the one Pi actually reads, so write
 * there. If none exist yet, create the one the adapter's own docs call the
 * standard shared location. Only bail to instructions when multiple
 * conflicting global configs already exist - guessing which one wins isn't
 * something this wizard can safely do.
 */
export async function registerPi(env: EnvVars): Promise<void> {
  const existing: string[] = [];
  for (const candidate of PI_GLOBAL_CANDIDATES) {
    if (await fileExists(candidate)) existing.push(candidate);
  }

  if (existing.length > 1) {
    p.log.warn(`Found more than one existing MCP config Pi might read (${existing.join(", ")}) - not guessing which one it actually uses.`);
    showPiInstructions(env);
    return;
  }

  if (existing.length === 0) {
    p.log.info(`No existing MCP config found - creating the standard shared location: ${PI_GLOBAL_CANDIDATES[0]}`);
  }
  const configPath = existing[0] ?? PI_GLOBAL_CANDIDATES[0];
  const written = await writeJsonMcpConfig(configPath, (raw) => mergeJsonMcpConfig(raw, "mcpServers", env), genericConfigSnippet(env), "Pi");
  if (!written) return;
  if (existing.length === 0) {
    p.log.info("If Pi doesn't pick this up, check its docs - it also reads project-local .mcp.json/.pi/mcp.json and a Pi-install-specific path this wizard doesn't know.");
  }
  await offerAskEnforcement(env.BITBUCKET_MCP_MODE, "Pi", (writeToolNames) => applyPiAskRules(configPath, writeToolNames));
  p.outro("Restart Pi - the Bitbucket tools will be available.");
}

/** Manual fallback for Pi - used when multiple existing global configs make automated writing unsafe. */
export function showPiInstructions(env: EnvVars): void {
  p.note(genericConfigSnippet(env), 'Paste this into your Pi MCP config, under "mcpServers"');
  p.log.info(
    "Pi checks (later ones override earlier): ~/.config/mcp/mcp.json, ~/.agents/mcp.json, ~/.agents/mcp/mcp.json, " +
      "<Pi agent dir>/mcp.json, .mcp.json, and .pi/mcp.json - use whichever matches your setup.",
  );
  p.outro("Nothing was changed - paste the block above into your chosen config file, then restart Pi.");
}

/** Generic fallback for any MCP-capable agent this wizard doesn't have dedicated support for. */
export function showGenericInstructions(env: EnvVars): void {
  p.note(genericConfigSnippet(env), "Standard MCP server config");
  p.outro(
    "Nothing was changed - this is the standard MCP stdio server shape most clients expect. " +
      "Check your agent's own MCP documentation for where its config file lives and what top-level key wraps this.",
  );
}
