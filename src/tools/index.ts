import { z } from "zod";
import { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { RequestContext } from "../context.js";
import { Mode, ToolWriteLevel } from "../scopeProbe.js";

type ZodRawShape = Record<string, z.ZodTypeAny>;
type ShapeOutput<Args extends ZodRawShape> = { [K in keyof Args]: z.infer<Args[K]> };

/**
 * Uniform description of one MCP tool, carrying both what the SDK needs to
 * register it (schema/annotations/handler) and what the gating logic in
 * scopeProbe.ts needs to decide whether to register it at all
 * (requiredScope, writeLevel).
 *
 * `onlyInModes`, when set, restricts which server Mode this exact ToolSpec
 * is eligible in at all - used for the handful of tools that need a
 * genuinely different inputSchema per mode (see tools/pullRequests.ts's
 * *Draft/*Full variant pairs), not just a different default. Tools without
 * it are eligible in every mode, subject to the normal writeLevel gating.
 */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  requiredScope: string;
  writeLevel: ToolWriteLevel;
  onlyInModes?: Mode[];
  handler: (args: Record<string, unknown>, context: RequestContext) => Promise<CallToolResult>;
}

/** Shared `workspace` field: optional, resolved against the configured default via toolHelpers.ts's resolveWorkspace(). */
export const workspaceField = { workspace: z.string().optional().describe("Omit to use the configured default workspace") };

/**
 * Defines one tool with full type inference at the call site (Args is
 * inferred from the inputSchema literal you pass in, and `handler`'s
 * parameter type is checked against it), then erases to the uniform
 * ToolSpec shape for storage in a flat array alongside every other tool.
 */
export function defineTool<Args extends ZodRawShape>(spec: {
  name: string;
  description: string;
  inputSchema: Args;
  outputSchema?: ZodRawShape;
  annotations: ToolAnnotations;
  requiredScope: string;
  writeLevel: ToolWriteLevel;
  onlyInModes?: Mode[];
  handler: (args: ShapeOutput<Args>, context: RequestContext) => Promise<CallToolResult>;
}): ToolSpec {
  return spec as unknown as ToolSpec;
}
