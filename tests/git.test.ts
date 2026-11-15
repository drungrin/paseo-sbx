import { describe, expect, it } from "vitest";
import { localRemotePath } from "../server/git";

describe("localRemotePath", () => {
  it("resolves absolute, file:// and relative paths against the repository", () => {
    expect(localRemotePath("/srv/git/app.git", "/work/app")).toBe("/srv/git/app.git");
    expect(localRemotePath("/srv/git/app.git/", "/work/app")).toBe("/srv/git/app.git");
    expect(localRemotePath("file:///srv/git/my%20app.git", "/work/app")).toBe("/srv/git/my app.git");
    expect(localRemotePath("../app.git", "/work/app")).toBe("/work/app.git");
    expect(localRemotePath("./bare:odd.git", "/work/app")).toBe("/work/app/bare:odd.git");
    expect(localRemotePath("mirrors/app.git", "/work/app")).toBe("/work/app/mirrors/app.git");
  });

  it("leaves network remotes out", () => {
    for (const url of [
      "git@github.com:org/app.git",
      "github.com:org/app.git",
      "ssh://git@github.com/org/app.git",
      "https://github.com/org/app.git",
      "git://example.com/app.git",
      "file://relative/app.git",
      "file://%E0%A4%A",
      "",
    ]) {
      expect(localRemotePath(url, "/work/app")).toBeNull();
    }
  });
});
