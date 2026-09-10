import { execFile } from "child_process";
import { promisify } from "util";
import * as p from "@clack/prompts";
import { BitbucketClient } from "../bitbucket/client.js";
import { StaticTokenCredentialProvider } from "../credentials.js";
import { UserSchema, WorkspaceAccessSchema } from "../bitbucket/types.js";
import { resolveMode } from "../config.js";

const execFileAsync = promisify(execFile);

/** The name this server is always registered under - shared with uninstall.ts. */
export const SERVER_NAME = "bitbucket";

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
 * `npx github:Stan15/bucket-mcp configure` - the entire setup flow in one
 * command. Deliberately does NOT invent a config file of our own: Claude
 * Code already persists env vars passed via `claude mcp add --env`, so this
 * just collects what's needed and drives that existing mechanism instead of
 * adding a second, redundant place credentials could live.
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

async function promptForNewToken(scopeLine: string): Promise<string> {
  p.note(
    "1. Bitbucket -> avatar -> Account settings -> Security -> Create and manage API tokens\n" +
      '2. Click "Create API token with scopes" (not the plain "Create API token" button)\n' +
      `3. Name it, pick Bitbucket, then search and check: ${scopeLine}\n` +
      "4. Create token - copy it now, you won't see it again\n" +
      "(other use cases: README.md#token-scopes-by-use-case)",
    "Create a token",
  );
  return requireNotCancelled(
    await p.password({
      message: "Paste your Bitbucket API token",
      validate: (value) => (value ? undefined : "A token is required"),
    }),
  );
}

export async function runConfigureWizard(): Promise<void> {
  p.intro("Bitbucket setup for Claude Code");

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
          hint: "can create draft PRs and pending comments/tasks - nothing goes live without a human in Bitbucket's UI",
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

  const scopeLine =
    mode === "readonly"
      ? "read:repository:bitbucket, read:pullrequest:bitbucket, read:user:bitbucket, read:workspace:bitbucket"
      : "read:repository:bitbucket, write:repository:bitbucket, read:pullrequest:bitbucket, write:pullrequest:bitbucket, read:user:bitbucket, read:workspace:bitbucket";

  let token: string;
  if (existing?.BITBUCKET_API_TOKEN) {
    const keepToken = requireNotCancelled(
      await p.confirm({ message: "Keep your existing Bitbucket API token?", initialValue: true }),
    );
    token = keepToken ? existing.BITBUCKET_API_TOKEN : await promptForNewToken(scopeLine);
  } else {
    token = await promptForNewToken(scopeLine);
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

    if (workspaces.length === 1) {
      defaultWorkspace = workspaces[0].workspace.slug;
      p.log.info(`Using "${defaultWorkspace}" as the default workspace.`);
    } else if (workspaces.length > 1) {
      const chosen = requireNotCancelled(
        await p.select({
          message: "Which workspace should be the default?",
          initialValue: workspaces.some((w) => w.workspace.slug === currentWorkspace) ? currentWorkspace : undefined,
          options: [
            ...workspaces.map((w) => ({ value: w.workspace.slug, label: w.workspace.name, hint: w.workspace.slug })),
            { value: undefined, label: "Skip - I'll specify one per request or set this later" },
          ],
        }),
      );
      defaultWorkspace = chosen;
    } else {
      p.log.warn("No workspaces found for this token - you can set BITBUCKET_DEFAULT_WORKSPACE later.");
    }
  } catch {
    workspaceSpinner.error("Couldn't fetch workspaces - you can set a default later.");
  }

  const alreadyRegistered = existing !== undefined;

  const claudeArgs = ["mcp", "add", "--scope", "user", "--transport", "stdio"];
  claudeArgs.push("--env", `BITBUCKET_API_TOKEN=${token}`);
  if (defaultWorkspace) claudeArgs.push("--env", `BITBUCKET_DEFAULT_WORKSPACE=${defaultWorkspace}`);
  claudeArgs.push("--env", `BITBUCKET_MCP_MODE=${mode}`);
  claudeArgs.push(SERVER_NAME, "--", "npx", "-y", "github:Stan15/bucket-mcp");

  const redactedArgs = claudeArgs.map((a) => (a.startsWith("BITBUCKET_API_TOKEN=") ? "BITBUCKET_API_TOKEN=***" : a));
  p.note(`claude ${redactedArgs.join(" ")}`, alreadyRegistered ? "About to run (replacing your existing setup)" : "About to run");

  const proceedAnswer = await p.confirm({
    message: alreadyRegistered ? "Replace your existing Bitbucket setup with this configuration?" : "Register this with Claude Code now?",
    initialValue: true,
  });
  if (p.isCancel(proceedAnswer)) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }
  if (!proceedAnswer) {
    p.outro("Skipped. Run the command above yourself when ready (with the real token, not the *** version).");
    return;
  }

  const registerSpinner = p.spinner();
  registerSpinner.start(alreadyRegistered ? "Updating existing registration" : "Running claude mcp add");
  try {
    // `claude mcp add` errors on a name that's already registered rather than
    // overwriting it, so a reconfigure has to remove the old one first.
    if (alreadyRegistered) await execFileAsync("claude", ["mcp", "remove", SERVER_NAME]);
    const { stderr } = await execFileAsync("claude", claudeArgs);
    registerSpinner.stop(alreadyRegistered ? "Updated" : "Registered with Claude Code");
    if (stderr.trim()) p.log.warn(stderr.trim());
    p.outro(`Restart Claude Code - the Bitbucket tools will be available in every project as ${userDisplayName}.`);
  } catch (error) {
    registerSpinner.error("Couldn't run 'claude' automatically");
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro("Run the command above yourself instead (with the real token, not the *** version).");
  }
}
