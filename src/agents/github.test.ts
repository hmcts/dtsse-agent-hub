import { describe, expect, it } from "vitest";
import { DEFAULT_GITHUB_ORG, githubOrg, repoFileBase } from "./github.ts";

describe("githubOrg", () => {
  it("should be HMCTS when the environment names no org", () => {
    expect(githubOrg({})).toBe(DEFAULT_GITHUB_ORG);
    expect(githubOrg({ GITHUB_ORG: "  " })).toBe("hmcts");
  });

  it("should be the org the environment names", () => {
    expect(githubOrg({ GITHUB_ORG: " acme " })).toBe("acme");
  });
});

describe("repoFileBase", () => {
  it("should be the repo's blob URL on the branch the agent reported", () => {
    expect(repoFileBase("cft-workspace", "master", {})).toBe("https://github.com/hmcts/cft-workspace/blob/master/");
    expect(repoFileBase("pcs-api", "feat/HDPI-1234-thing", {})).toBe("https://github.com/hmcts/pcs-api/blob/feat/HDPI-1234-thing/");
    expect(repoFileBase("hmcts.github.io", "main", {})).toBe("https://github.com/hmcts/hmcts.github.io/blob/main/");
  });

  it("should be the org the environment names", () => {
    expect(repoFileBase("thing", "master", { GITHUB_ORG: "acme" })).toBe("https://github.com/acme/thing/blob/master/");
  });

  it("should fall back to HEAD when there is no branch, so the link survives the branch being deleted", () => {
    expect(repoFileBase("cft-workspace", null, {})).toBe("https://github.com/hmcts/cft-workspace/blob/HEAD/");
  });

  it("should fall back to HEAD when the branch is not a spelling a ref can have", () => {
    for (const branch of ["a/../b", "..", "has space", "with~tilde", "quote'", "/leading", "trailing/", "a//b", ""]) {
      expect(repoFileBase("thing", branch, {})).toBe("https://github.com/hmcts/thing/blob/HEAD/");
    }
  });

  it("should be null when there is no repo or its name is not one GitHub could serve", () => {
    expect(repoFileBase(null, "master", {})).toBeNull();
    for (const repo of ["..", ".", "a/b", "has space", "-leading-dash", "", "with~tilde"]) {
      expect(repoFileBase(repo, "master", {})).toBeNull();
    }
  });

  it("should read the process environment when none is passed", () => {
    expect(repoFileBase("thing", "master")).toBe(`https://github.com/${githubOrg()}/thing/blob/master/`);
  });
});
