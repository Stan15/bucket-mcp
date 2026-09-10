import { describe, expect, it } from "vitest";
import { MissingWorkspaceError, resolveWorkspace } from "../../../src/tools/toolHelpers.js";
import { RequestContext } from "../../../src/context.js";

const bitbucket = {} as RequestContext["bitbucket"];

describe("resolveWorkspace", () => {
  it("uses the explicit workspace argument when given, ignoring any default", () => {
    const context: RequestContext = { bitbucket, defaultWorkspace: "default-ws" };
    expect(resolveWorkspace("explicit-ws", context)).toBe("explicit-ws");
  });

  it("falls back to the configured default when no argument is given", () => {
    const context: RequestContext = { bitbucket, defaultWorkspace: "default-ws" };
    expect(resolveWorkspace(undefined, context)).toBe("default-ws");
  });

  it("throws a MissingWorkspaceError when neither is available", () => {
    const context: RequestContext = { bitbucket };
    expect(() => resolveWorkspace(undefined, context)).toThrow(MissingWorkspaceError);
  });

  it("the error message points at bitbucket_workspace_list as the way out", () => {
    const context: RequestContext = { bitbucket };
    expect(() => resolveWorkspace(undefined, context)).toThrow(/bitbucket_workspace_list/);
  });
});
