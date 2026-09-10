import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BitbucketApiError } from "../bitbucket/client.js";

/**
 * Error model decision (see mcp-best-practices.md): every Bitbucket failure
 * becomes a Tool Execution Error (isError:true content the model can read
 * and act on), never a thrown protocol error. A 403 carries the exact
 * missing-scope detail BitbucketApiError already extracted from the
 * x-oauth-scopes/x-accepted-oauth-scopes headers; a 429 carries the
 * Retry-After value. Both are actionable text, not a bare status code.
 */
export function errorResult(error: unknown): CallToolResult {
  if (error instanceof BitbucketApiError) {
    return { content: [{ type: "text", text: error.message }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Successful result carrying both structuredContent (for clients that
 * validate/render against outputSchema) and a text fallback (spec guidance:
 * servers SHOULD also return the same data as TextContent for clients that
 * don't look at structuredContent).
 */
export function okResult(structured: Record<string, unknown>, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

/** Wraps a handler so a thrown BitbucketApiError (or anything else) becomes a Tool Execution Error instead of crashing the server. */
export function withErrorHandling<Args extends unknown[]>(
  handler: (...args: Args) => Promise<CallToolResult>,
): (...args: Args) => Promise<CallToolResult> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      return errorResult(error);
    }
  };
}
