import { ToolSpec } from "./index.js";
import { repositoryTools } from "./repositories.js";
import { pullRequestTools } from "./pullRequests.js";
import { commitTools } from "./commits.js";
import { refTools } from "./refs.js";
import { searchTools } from "./search.js";
import { sourceTools } from "./source.js";
import { userTools } from "./user.js";
import { isToolAllowed, Mode } from "../scopeProbe.js";

/** Every tool this server can register, before mode/scope gating. Shared between server.ts (runtime registration) and the CLI (e.g. to know which tool names are write operations for a given mode). */
export const ALL_TOOLS: ToolSpec[] = [
  ...repositoryTools,
  ...pullRequestTools,
  ...commitTools,
  ...refTools,
  ...searchTools,
  ...sourceTools,
  ...userTools,
];

/**
 * Tool names that would actually be registered under `mode` (ignoring
 * scope entirely - this is a naming question, not a permission check) and
 * that write anything at all (writeLevel "draft" or "write", not "read").
 * Used by the CLI to build a host-agent permission rule ("always ask
 * before these specific tools run") without hand-maintaining a duplicate
 * tool list that could drift from the real one.
 */
export function writeOperationToolNames(mode: Mode): string[] {
  return ALL_TOOLS.filter((tool) => {
    if (tool.onlyInModes && !tool.onlyInModes.includes(mode)) return false;
    if (tool.writeLevel === "read") return false;
    return isToolAllowed({ kind: "unknown" }, tool.requiredScope, tool.writeLevel, mode, false);
  }).map((tool) => tool.name);
}
