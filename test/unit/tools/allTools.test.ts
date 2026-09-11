import { describe, expect, it } from "vitest";
import { writeOperationToolNames } from "../../../src/tools/allTools.js";

describe("writeOperationToolNames", () => {
  it("readonly mode has no write operations at all", () => {
    expect(writeOperationToolNames("readonly")).toEqual([]);
  });

  it("draft mode lists only the three enforced-non-live create tools", () => {
    expect(writeOperationToolNames("draft")).toEqual([
      "bitbucket_pull_request_create",
      "bitbucket_pull_request_comment_create",
      "bitbucket_pull_request_task_create",
    ]);
  });

  it("readwrite mode includes merge/decline/branch_delete and excludes every read-only tool", () => {
    const names = writeOperationToolNames("readwrite");
    expect(names).toEqual(
      expect.arrayContaining(["bitbucket_pull_request_merge", "bitbucket_pull_request_decline", "bitbucket_branch_delete"]),
    );
    expect(names).not.toContain("bitbucket_pull_request_get");
    expect(names).not.toContain("bitbucket_repository_get");
  });

  it("readwrite is a strict superset of draft's write tools", () => {
    const draft = writeOperationToolNames("draft");
    const readwrite = writeOperationToolNames("readwrite");
    for (const name of draft) expect(readwrite).toContain(name);
  });
});
