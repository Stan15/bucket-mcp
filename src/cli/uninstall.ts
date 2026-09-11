import * as p from "@clack/prompts";
import { planUninstall } from "./agents.js";

/**
 * `npx bucket-mcp uninstall` - scans every target `configure` can write to
 * (every agent's registration, plus the "ask enforcement" permission rules
 * offered for Claude Code/OpenCode) and removes whatever it actually finds,
 * after one confirmation - not just Claude Code, since configure can
 * register this server with several different agents across separate runs.
 */
export async function runUninstallWizard(): Promise<void> {
  p.intro("Remove Bitbucket");

  const spinner = p.spinner();
  spinner.start("Scanning for Bitbucket registrations and permission rules");
  const items = await planUninstall();
  spinner.stop(items.length > 0 ? `Found ${items.length} item(s)` : "Found nothing");

  if (items.length === 0) {
    p.outro("Nothing to remove.");
    return;
  }

  p.note(items.map((item) => `- ${item.label}`).join("\n"), "Found");

  const confirmed = await p.confirm({ message: "Remove all of the above?", initialValue: false });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled - nothing was changed.");
    return;
  }

  let removedCount = 0;
  for (const item of items) {
    const itemSpinner = p.spinner();
    itemSpinner.start(`Removing: ${item.label}`);
    try {
      await item.remove();
      itemSpinner.stop(`Removed: ${item.label}`);
      removedCount++;
    } catch (error) {
      itemSpinner.error(`Couldn't remove: ${item.label}`);
      p.log.error(error instanceof Error ? error.message : String(error));
    }
  }

  p.outro(
    removedCount === items.length
      ? "Restart whichever agents were affected to finish removing the Bitbucket tools."
      : `Removed ${removedCount}/${items.length} - see the errors above for what needs manual cleanup.`,
  );
}
