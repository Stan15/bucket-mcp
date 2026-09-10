import { describe, expect, it } from "vitest";
import { testBitbucketClient } from "../../test/support/testClient.js";
import { route } from "../../test/support/fakeFetch.js";
import { sourceTools } from "./source.js";
import { RequestContext } from "../context.js";

const sourceGet = sourceTools.find((t) => t.name === "bitbucket_source_get")!;
const args = { workspace: "ws", repoSlug: "repo", revision: "main" };

describe("bitbucket_source_get", () => {
  it("returns raw text for a file (content-type is not application/json - confirmed against real Bitbucket responses)", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/src/main/package.json", { status: 200, body: '{"name":"x"}' }),
    ]);
    const result = await sourceGet.handler({ ...args, path: "package.json" }, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ content: '{"name":"x"}', truncated: false });
  });

  it("truncates file content over the size cap and says so", async () => {
    const big = "x".repeat(60_000);
    const bitbucket = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo/src/main/big.txt", { status: 200, body: big })]);
    const result = await sourceGet.handler({ ...args, path: "big.txt" }, { bitbucket } as RequestContext);
    expect(result.structuredContent?.truncated).toBe(true);
    expect((result.structuredContent?.content as string).length).toBe(50_000);
    expect((result.content as { text: string }[])[0].text).toContain("truncated at 50000 characters");
  });

  it("lists directory entries for a JSON paginated response", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/src/main/src", {
        status: 200,
        body: { values: [{ type: "commit_directory", path: "src/lib" }, { type: "commit_file", path: "src/index.ts", size: 512 }] },
      }),
    ]);
    const result = await sourceGet.handler({ ...args, path: "src" }, { bitbucket } as RequestContext);
    expect(result.structuredContent?.entries).toHaveLength(2);
    expect((result.content as { text: string }[])[0].text).toContain("src/index.ts");
  });

  it("returns file metadata directly (not a paginated list) when metaOnly is set", async () => {
    const bitbucket = testBitbucketClient([
      route("GET", "/2.0/repositories/ws/repo/src/main/package.json", { status: 200, body: { type: "commit_file", path: "package.json", size: 9811 } }),
    ]);
    const result = await sourceGet.handler({ ...args, path: "package.json", metaOnly: true }, { bitbucket } as RequestContext);
    expect(result.structuredContent).toMatchObject({ entry: { path: "package.json", size: 9811 } });
  });

  it("reports an empty directory clearly rather than silently returning nothing", async () => {
    const bitbucket = testBitbucketClient([route("GET", "/2.0/repositories/ws/repo/src/main/empty", { status: 200, body: { values: [] } })]);
    const result = await sourceGet.handler({ ...args, path: "empty" }, { bitbucket } as RequestContext);
    expect((result.content as { text: string }[])[0].text).toContain("empty or does not exist");
  });
});
