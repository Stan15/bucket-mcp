import { execFile } from "child_process";
import { promisify } from "util";
import * as p from "@clack/prompts";
import { getExistingRegistration, SERVER_NAME } from "./configure.js";

const execFileAsync = promisify(execFile);

/** `npx github:Stan15/bucket-mcp uninstall` - removes the Bitbucket MCP server registration from Claude Code. */
export async function runUninstallWizard(): Promise<void> {
  p.intro("Remove Bitbucket from Claude Code");

  let registered: boolean;
  try {
    registered = (await getExistingRegistration(SERVER_NAME)) !== undefined;
  } catch (error) {
    // Distinguish "claude isn't runnable" from "nothing registered" - silently
    // reporting the latter here would be actively misleading.
    p.cancel(`Couldn't check whether ${SERVER_NAME} is registered: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
    return;
  }
  if (!registered) {
    p.outro(`No "${SERVER_NAME}" MCP server is registered - nothing to remove.`);
    return;
  }

  const confirmed = await p.confirm({
    message: "Remove the Bitbucket MCP server from Claude Code?",
    initialValue: false,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }

  const spinner = p.spinner();
  spinner.start("Removing");
  try {
    const { stderr } = await execFileAsync("claude", ["mcp", "remove", SERVER_NAME]);
    spinner.stop("Removed");
    if (stderr.trim()) p.log.warn(stderr.trim());
    p.outro("Restart Claude Code to finish removing the Bitbucket tools.");
  } catch (error) {
    spinner.error("Couldn't remove automatically");
    p.log.error(error instanceof Error ? error.message : String(error));
    p.outro(`Run \`claude mcp remove ${SERVER_NAME}\` yourself instead.`);
  }
}
