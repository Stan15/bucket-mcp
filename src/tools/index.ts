import { z } from "zod";
import { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { RequestContext } from "../context.js";

type ZodRawShape = Record<string, z.ZodTypeAny>;
type ShapeOutput<Args extends ZodRawShape> = { [K in keyof Args]: z.infer<Args[K]> };

/**
 * Uniform description of one MCP tool, carrying both what the SDK needs to
 * register it (schema/annotations/handler) and what the gating logic in
 * scopeProbe.ts needs to decide whether to register it at all
 * (requiredScope, isWriteOrDestructive).
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  requiredScope: string;
  isWriteOrDestructive: boolean;
  handler: (args: Record<string, unknown>, context: RequestContext) => Promise<CallToolResult>;
}

/**
 * Defines one tool with full type inference at the call site (Args is
 * inferred from the inputSchema literal you pass in, and `handler`'s
 * parameter type is checked against it), then erases to the uniform
 * ToolSpec shape for storage in a flat array alongside every other tool.
 */
/** Shared `workspace` field: optional, resolved against the configured default via toolHelpers.ts's resolveWorkspace(). */
export const workspaceField = { workspace: z.string().optional().describe("Omit to use the configured default workspace") };

export function defineTool<Args extends ZodRawShape>(spec: {
  name: string;
  description: string;
  inputSchema: Args;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  requiredScope: string;
  isWriteOrDestructive: boolean;
  handler: (args: ShapeOutput<Args>, context: RequestContext) => Promise<CallToolResult>;
}): ToolSpec {
  return spec as unknown as ToolSpec;
}
