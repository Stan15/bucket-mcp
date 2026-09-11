import { execFile } from "child_process";
import { promisify } from "util";
import * as p from "@clack/prompts";
import { BitbucketApiError, BitbucketClient, missingScopes } from "../bitbucket/client.js";
import { StaticTokenCredentialProvider } from "../credentials.js";
import { UserSchema, WorkspaceAccessSchema } from "../bitbucket/types.js";
import { resolveMode } from "../config.js";
import { EnvVars, pickAgent, registerClaudeCode, registerCodex, registerCopilot, registerCursor, registerOpenCode, registerPi, showGenericInstructions } from "./agents.js";
import { SERVER_NAME } from "./constants.js";

const execFileAsync = promisify(execFile);

/**
 * `claude mcp get <name>` has no `--json` output, so this parses its
 * "Environment:" section - one `KEY=value` per line, indented, ending at the
 * first blank line or unindented line - out of the plain-text listing.
 */
export function parseRegisteredEnvironment(claudeMcpGetOutput: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = claudeMcpGetOutput.split("\n");
  const envHeaderIndex = lines.findIndex((line) => line.trim() === "Environment:");
  if (envHeaderIndex === -1) return env;
  for (const line of lines.slice(envHeaderIndex + 1)) {
    const match = line.match(/^\s+([A-Z0-9_]+)=(.*)$/);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return env;
}

/**
 * Returns undefined when nothing by that name is registered - distinguished
 * from a genuine failure to run `claude` at all (e.g. it isn't on PATH),
 * which throws instead, so callers don't mistake "can't tell" for
 * "definitely not registered".
 */
export async function getExistingRegistration(name: string): Promise<Record<string, string> | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("claude", ["mcp", "get", name]));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code !== "ENOENT") return undefined;
    throw error;
  }
  return parseRegisteredEnvironment(stdout);
}

/**
 * `npx bucket-mcp configure` - the entire setup flow in one command,
 * ending with a choice of which MCP-capable agent to register with (see
 * agents.ts). Deliberately does NOT invent a config file of our own: every
 * agent this wizard supports already has its own place to persist an MCP
 * server's env vars (`claude mcp add --env`, a JSON config file, etc.), so
 * this just collects what's needed and drives that existing mechanism
 * instead of adding a second, redundant place credentials could live.
 *
 * Uses @clack/prompts rather than hand-rolled readline/raw-mode handling -
 * this is a setup-time-only dependency (never touches the MCP server's
 * runtime or its tool-list token footprint), so the "minimal dependencies"
 * bar that applies to the server itself doesn't apply here, and a
 * well-tested prompt library beats reinventing masked input, cancellation,
 * and arrow-key selection by hand.
 */
function requireNotCancelled<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled - nothing was changed.");
    process.exit(0);
  }
  // isCancel() only narrows the built-in cancel symbol out of a `T | symbol`
  // union when T is concrete, not generic - by this point value can't be
  // that symbol, so the cast just states what the guard above already proved.
  return value as T;
}

const SCOPES_GUIDE_URL = "https://github.com/Stan15/bucket-mcp#token-scopes-by-use-case";

/**
 * OSC 8 terminal hyperlink - the standard escape sequence terminals use to
 * render clickable text with their normal link styling/cursor, rather than
 * a plain URL string or some invented visual marker. Confirmed safe here:
 * @clack/prompts measures box/note width via fast-string-truncated-width,
 * whose ANSI regex has an explicit clause for this exact OSC 8 pattern, so
 * the hyperlink is correctly treated as zero-width and won't throw off the
 * note's border wrapping the way a raw escape sequence otherwise might.
 */
function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
}

async function promptForNewToken(): Promise<string> {
  p.note(
    "1. Bitbucket -> avatar -> Account settings -> Security -> Create and manage API tokens\n" +
      '2. Click "Create API token with scopes" (not the plain "Create API token" button)\n' +
      "3. Name it, set expiry to a few months out (not the max), then Next\n" +
      "4. Pick Bitbucket, then Next\n" +
      `5. Select the scopes you want - see this ${hyperlink("guide", SCOPES_GUIDE_URL)} to help you choose\n` +
      "6. Create token - copy it now, you won't see it again",
    "Create a token",
  );
  return requireNotCancelled(
    await p.password({
      message: "Paste your Bitbucket API token",
      // Bitbucket tokens run ~190+ characters - clack's password prompt has
      // no width cap, so masking that long always wraps across terminal
      // lines regardless of mask character. A dot is at least the
      // conventional, visually lighter password-field look instead of the
      // default solid block, which reads as heavier/messier at that length.
      mask: "•",
      validate: (value) => (value ? undefined : "A token is required"),
    }),
  );
}

export async function runConfigureWizard(): Promise<void> {
  p.intro("Bitbucket MCP server setup");

  let existing: Record<string, string> | undefined;
  try {
    existing = await getExistingRegistration(SERVER_NAME);
  } catch (error) {
    p.cancel(
      `Couldn't check for an existing "${SERVER_NAME}" registration: ${error instanceof Error ? error.message : error}. ` +
        "Is Claude Code's `claude` CLI installed and on your PATH?",
    );
    process.exitCode = 1;
    return;
  }

  let currentMode: ReturnType<typeof resolveMode> | undefined;
  if (existing) {
    try {
      currentMode = resolveMode(existing);
    } catch {
      // An unrecognized BITBUCKET_MCP_MODE value (hand-edited, or from a
      // future version) shouldn't crash the one tool meant to fix it.
      p.log.warn(`Your existing BITBUCKET_MCP_MODE ("${existing.BITBUCKET_MCP_MODE}") isn't a value this version recognizes - pick one below.`);
    }
  }
  const currentWorkspace = existing?.BITBUCKET_DEFAULT_WORKSPACE;

  if (existing) {
    p.note(`Mode: ${currentMode ?? "(unrecognized)"}\nDefault workspace: ${currentWorkspace ?? "(none set)"}`, "You're already configured");
  }

  const mode = requireNotCancelled(
    await p.select({
      message: "Which permission mode?",
      initialValue: currentMode ?? "draft",
      options: [
        {
          value: "draft",
          label: "Draft (recommended)",
          hint: "creates drafts/pending items only - a human finalizes them in Bitbucket",
        },
        {
          value: "readonly",
          label: "Read-only",
          hint: "no write or destructive tool of any kind",
        },
        {
          value: "readwrite",
          label: "Read-write",
          hint: "full access, including merge/decline/delete",
        },
      ],
    }),
  );

  if (mode === "readwrite") {
    p.log.warn("Full write access includes irreversible actions (merge, decline, delete).");
  }

  let token: string;
  if (existing?.BITBUCKET_API_TOKEN) {
    const keepToken = requireNotCancelled(
      await p.confirm({ message: "Keep your existing Bitbucket API token?", initialValue: true }),
    );
    token = keepToken ? existing.BITBUCKET_API_TOKEN : await promptForNewToken();
  } else {
    token = await promptForNewToken();
  }

  const client = new BitbucketClient(new StaticTokenCredentialProvider(token));

  const validateSpinner = p.spinner();
  validateSpinner.start("Validating token");
  let userDisplayName: string;
  try {
    const user = await client.get("/user", undefined, UserSchema);
    userDisplayName = user.display_name;
    validateSpinner.stop(`Connected as ${userDisplayName}`);
  } catch (error) {
    validateSpinner.error("Validation failed");
    p.cancel(`Couldn't validate that token: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }

  let defaultWorkspace: string | undefined;
  const workspaceSpinner = p.spinner();
  workspaceSpinner.start("Fetching your workspaces");
  try {
    const { values: workspaces } = await client.paginate("/user/workspaces", undefined, 50, WorkspaceAccessSchema);
    workspaceSpinner.stop(`Found ${workspaces.length} workspace(s)`);

    if (workspaces.length > 0) {
      const chosen = requireNotCancelled(
        await p.select({
          message: "Which workspace should be the default?",
          initialValue:
            workspaces.length === 1
              ? workspaces[0].workspace.slug
              : workspaces.some((w) => w.workspace.slug === currentWorkspace)
                ? currentWorkspace
                : undefined,
          options: [
            ...workspaces.map((w) => ({ value: w.workspace.slug, label: w.workspace.name ?? w.workspace.slug, hint: w.workspace.slug })),
            { value: undefined, label: "No default - I'll specify one per request or set this later" },
          ],
        }),
      );
      defaultWorkspace = chosen;
    } else {
      p.log.warn("No workspaces found for this token - you can set BITBUCKET_DEFAULT_WORKSPACE later.");
    }
  } catch (error) {
    if (error instanceof BitbucketApiError && error.status === 403 && error.acceptedScopes) {
      const missing = missingScopes(error.acceptedScopes, error.grantedScopes);
      workspaceSpinner.error(`Your token is missing scope(s): ${missing.join(", ")}`);
      p.log.info("Add that to your token to fetch your workspace list, or continue without a default workspace.");
    } else {
      workspaceSpinner.error(`Couldn't fetch workspaces: ${error instanceof Error ? error.message : error}`);
      p.log.info("You can still continue without a default workspace and set BITBUCKET_DEFAULT_WORKSPACE later.");
    }
  }

  const alreadyRegisteredWithClaude = existing !== undefined;
  const env: EnvVars = { BITBUCKET_API_TOKEN: token, BITBUCKET_DEFAULT_WORKSPACE: defaultWorkspace, BITBUCKET_MCP_MODE: mode };

  const agent = await pickAgent();
  switch (agent) {
    case "claude":
      await registerClaudeCode(env, alreadyRegisteredWithClaude, userDisplayName);
      break;
    case "codex":
      await registerCodex(env);
      break;
    case "cursor":
      await registerCursor(env);
      break;
    case "copilot":
      await registerCopilot(env);
      break;
    case "pi":
      await registerPi(env);
      break;
    case "opencode":
      await registerOpenCode(env);
      break;
    case "other":
      showGenericInstructions(env);
      break;
  }
}
