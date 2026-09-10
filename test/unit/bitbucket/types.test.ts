import { describe, expect, it } from "vitest";
import { MergeTaskStatusSchema, PullRequestSchema, TreeEntrySchema, UserSchema } from "../../../src/bitbucket/types.js";

describe("UserSchema", () => {
  it("parses a nested user summary trimmed to just display_name (no uuid) - the shape `fields=` deliberately produces", () => {
    expect(() => UserSchema.parse({ display_name: "Ada Lovelace" })).not.toThrow();
  });

  it("still requires display_name", () => {
    expect(() => UserSchema.parse({ uuid: "{abc}" })).toThrow();
  });
});

describe("TreeEntrySchema", () => {
  it("accepts attributes as an array (the real shape confirmed live against api.bitbucket.org)", () => {
    expect(() => TreeEntrySchema.parse({ type: "commit_file", path: "package.json", size: 9811, attributes: [] })).not.toThrow();
  });

  it("also accepts attributes as a single string (what the formal OpenAPI schema declares, even though live data disagrees)", () => {
    expect(() => TreeEntrySchema.parse({ type: "commit_file", path: "x", attributes: "binary" })).not.toThrow();
  });

  it("accepts a directory entry with no size/attributes at all", () => {
    expect(() => TreeEntrySchema.parse({ type: "commit_directory", path: "src" })).not.toThrow();
  });
});

describe("PullRequestSchema", () => {
  it("parses a minimal PR trimmed via `fields=` down to just the list-view fields", () => {
    const minimal = { id: 1, title: "Fix bug", state: "OPEN" };
    expect(() => PullRequestSchema.parse(minimal)).not.toThrow();
  });
});

describe("MergeTaskStatusSchema", () => {
  it("parses a PENDING status with no merge_result", () => {
    expect(() => MergeTaskStatusSchema.parse({ task_status: "PENDING" })).not.toThrow();
  });

  it("parses a SUCCESS status carrying the merged PR", () => {
    expect(() =>
      MergeTaskStatusSchema.parse({ task_status: "SUCCESS", merge_result: { id: 1, title: "x", state: "MERGED" } }),
    ).not.toThrow();
  });
});
