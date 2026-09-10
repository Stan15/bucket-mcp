import { z } from "zod";
import { TreeEntry, TreeEntrySchema } from "../bitbucket/types.js";
import { defineTool, ToolSpec, workspaceField } from "./index.js";
import { okResult, resolveWorkspace, withErrorHandling } from "./toolHelpers.js";

/**
 * GET .../src/{revision}/{path} is genuinely bimodal (confirmed via the
 * live spec's description, which the formal schema under-documents): if
 * `path` points to a file, the response is raw file content (any
 * content-type, handled by bitbucket/client.ts's existing text/JSON
 * branch); if it points to a directory, the response is a paginated JSON
 * list of commit_file/commit_directory entries. There is no way to know
 * which one you'll get without either calling `?format=meta` first or just
 * inspecting what came back - this tool does the latter, since an extra
 * round-trip to check first would cost more than just branching on the
 * actual response.
 */

// Large files aren't useful dumped whole into a review conversation - cap
// and tell the caller how to get just the metadata (size/type) instead of
// guessing blindly and returning something huge.
const MAX_FILE_CHARS = 50_000;

const sourceGet = defineTool({
  name: "bitbucket_source_get",
  description:
    "Read a file's contents or list a directory at a given revision. Omit `path` (or use \"\") for the repository root. " +
    "Set `metaOnly: true` to check a file's size/type without fetching its full contents - do this first for anything " +
    "that might be large.",
  inputSchema: {
    ...workspaceField,
    repoSlug: z.string(),
    revision: z.string().describe("Branch name, tag, or commit hash - e.g. 'main' or a PR's source branch"),
    path: z.string().optional().describe('File or directory path; omit for the repository root'),
    metaOnly: z.boolean().optional().describe("Return JSON metadata (size, type, attributes) instead of full file contents"),
  },
  annotations: { readOnlyHint: true, idempotentHint: true },
  requiredScope: "read:repository:bitbucket",
  writeLevel: "read",
  handler: withErrorHandling(async (args, context) => {
    const workspace = resolveWorkspace(args.workspace, context);
    const { bitbucket } = context;
    const path = args.path ? `/${args.path}` : "";
    const body = await bitbucket.get<unknown>(
      `/repositories/${workspace}/${args.repoSlug}/src/${args.revision}${path}`,
      { format: args.metaOnly ? "meta" : undefined },
    );

    // Directory listing (or file metadata): JSON object, not a raw string.
    if (typeof body !== "string") {
      if (isTreeEntry(body)) {
        // format=meta on a file returns one entry directly, not a paginated list.
        return summarizeEntry(body);
      }
      const page = body as { values?: unknown[] };
      const entries = (page.values ?? []).map((v) => TreeEntrySchema.parse(v));
      if (entries.length === 0) {
        return okResult({ entries: [] }, `${args.path || "/"} is empty or does not exist.`);
      }
      const text = entries.map((e) => `${e.type === "commit_directory" ? "dir " : "file"}  ${e.path}${e.size !== undefined ? ` (${e.size}b)` : ""}`).join("\n");
      return okResult({ entries }, text);
    }

    // Raw file content.
    const truncated = body.length > MAX_FILE_CHARS;
    const content = truncated ? body.slice(0, MAX_FILE_CHARS) : body;
    const note = truncated
      ? `\n\n[truncated at ${MAX_FILE_CHARS} characters - full file is ${body.length} characters; use metaOnly first to check size, or scope down further]`
      : "";
    return okResult({ content, truncated }, content + note);
  }),
});

function isTreeEntry(value: unknown): value is TreeEntry {
  return typeof value === "object" && value !== null && "type" in value && ((value as { type: unknown }).type === "commit_file" || (value as { type: unknown }).type === "commit_directory");
}

function summarizeEntry(entry: TreeEntry) {
  const text = `${entry.type === "commit_directory" ? "Directory" : "File"}: ${entry.path}${entry.size !== undefined ? ` (${entry.size} bytes)` : ""}`;
  return okResult({ entry }, text);
}

export const sourceTools: ToolSpec[] = [sourceGet];
