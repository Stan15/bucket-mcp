import { execFile } from "child_process";
import * as p from "@clack/prompts";
import { BitbucketClient } from "../bitbucket/client.js";
import { StaticTokenCredentialProvider } from "../credentials.js";
import { UserSchema, WorkspaceAccessSchema } from "../bitbucket/types.js";

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

export async function runConfigureWizard(): Promise<void> {
  p.intro("Bitbucket setup for Claude Code");

  p.note(
    "1. Bitbucket -> your avatar -> Personal settings -> API tokens -> Create token\n" +
      "2. Check: Repositories (Read + Write), Pull requests (Read + Write), User (Read), Workspaces (Read)\n" +
      "   (Only want read access? Check just the Read boxes.)\n" +
      "3. Copy the token - you won't be able to see it again",
    "Create a token",
  );

  const token = requireNotCancelled(
    await p.password({
      message: "Paste your Bitbucket API token",
      validate: (value) => (value ? undefined : "A token is required"),
    }),
  );

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
          options: [
            ...workspaces.map((w) => ({ value: w.workspace.slug, label: w.workspace.name, hint: w.workspace.slug })),
            { value: undefined, label: "Skip - I'll specify one per request or set this later" },
          ],
        }),
      );
      defaultWorkspace = chosen;
    }
  } catch {
    workspaceSpinner.error("Couldn't fetch workspaces - you can set a default later.");
  }

  const readOnly = requireNotCancelled(
    await p.confirm({
      message: "Read-only mode? (removes merge/comment/approve/delete and every other write tool)",
      initialValue: false,
    }),
  );

  const claudeArgs = ["mcp", "add", "--scope", "user", "--transport", "stdio"];
  claudeArgs.push("--env", `BITBUCKET_API_TOKEN=${token}`);
  if (defaultWorkspace) claudeArgs.push("--env", `BITBUCKET_DEFAULT_WORKSPACE=${defaultWorkspace}`);
  if (readOnly) claudeArgs.push("--env", "BITBUCKET_MCP_READONLY=1");
  claudeArgs.push("bitbucket", "--", "npx", "-y", "github:Stan15/bucket-mcp");

  const redactedArgs = claudeArgs.map((a) => (a.startsWith("BITBUCKET_API_TOKEN=") ? "BITBUCKET_API_TOKEN=***" : a));
  p.note(`claude ${redactedArgs.join(" ")}`, "About to run");

  const proceedAnswer = await p.confirm({ message: "Register this with Claude Code now?", initialValue: true });
  if (p.isCancel(proceedAnswer)) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }
  if (!proceedAnswer) {
    p.outro("Skipped. Run the command above yourself when ready (with the real token, not the *** version).");
    return;
  }

  const registerSpinner = p.spinner();
  registerSpinner.start("Running claude mcp add");
  await new Promise<void>((resolve) => {
    execFile("claude", claudeArgs, (error, _stdout, stderr) => {
      if (error) {
        registerSpinner.error("Couldn't run 'claude' automatically");
        p.log.error(error.message);
        p.outro("Run the command above yourself instead (with the real token, not the *** version).");
      } else {
        registerSpinner.stop("Registered with Claude Code");
        if (stderr.trim()) p.log.warn(stderr.trim());
        p.outro(`Restart Claude Code - the Bitbucket tools will be available in every project as ${userDisplayName}.`);
      }
      resolve();
    });
  });
}
