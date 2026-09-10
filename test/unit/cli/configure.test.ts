import { describe, expect, it } from "vitest";
import { parseRegisteredEnvironment } from "../../../src/cli/configure.js";

describe("parseRegisteredEnvironment", () => {
  it("parses the Environment: block out of a real `claude mcp get` listing", () => {
    const output =
      "bitbucket:\n" +
      "  Scope: User config (available in all your projects)\n" +
      "  Status: ✓ Connected\n" +
      "  Type: stdio\n" +
      "  Command: npx\n" +
      "  Args: -y github:Stan15/bucket-mcp\n" +
      "  Environment:\n" +
      "    BITBUCKET_API_TOKEN=faketoken123\n" +
      "    BITBUCKET_DEFAULT_WORKSPACE=my-team\n" +
      "    BITBUCKET_MCP_MODE=readwrite\n" +
      "\n" +
      "To remove this server, run: claude mcp remove bitbucket -s user\n";

    expect(parseRegisteredEnvironment(output)).toEqual({
      BITBUCKET_API_TOKEN: "faketoken123",
      BITBUCKET_DEFAULT_WORKSPACE: "my-team",
      BITBUCKET_MCP_MODE: "readwrite",
    });
  });

  it("returns an empty object when the server is registered with no env vars", () => {
    const output = "bitbucket:\n  Scope: User config\n  Type: stdio\n  Command: echo\n  Environment:\n\nTo remove this server, run: claude mcp remove bitbucket -s user\n";

    expect(parseRegisteredEnvironment(output)).toEqual({});
  });

  it("returns an empty object when there's no Environment: section at all", () => {
    expect(parseRegisteredEnvironment("bitbucket:\n  Scope: User config\n  Type: stdio\n")).toEqual({});
  });

  it("preserves '=' characters inside a value, like base64 padding in a token", () => {
    const output = "bitbucket:\n  Environment:\n    BITBUCKET_API_TOKEN=abc==def=ghi\n";

    expect(parseRegisteredEnvironment(output)).toEqual({ BITBUCKET_API_TOKEN: "abc==def=ghi" });
  });
});
