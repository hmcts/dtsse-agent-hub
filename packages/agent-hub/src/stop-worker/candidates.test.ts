import { describe, expect, it } from "vitest";
import { candidateTopics } from "./candidates.ts";
import { extractTouches } from "./touches.ts";

const ROOT = "/work/hmcts";
const W = "/work/cft-workspace";
const WS = "cft-workspace";
const NONE_WORKED = { repos: [], products: [] };

const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const touchesOf = (entries: unknown[]) => extractTouches(`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, { root: W, workspaceRepo: WS });

describe("candidateTopics", () => {
  it("should find repos and products when the transcript holds relative and absolute workspace paths", () => {
    // Arrange
    const text = [
      "Edited apps/pcs/pcs-api/src/main/Foo.java and ./apps/ccd/ccd-data-store-api/build.gradle.",
      "Also /work/hmcts/libs/ccd-config-generator/README.md and `platops/cnp-flux-config`.",
      "Docs in apps/wa/docs/how-to.md, apps/xui/CLAUDE.md and apps/em/.claude/skills.",
      "Not these: /elsewhere/apps/foo/bar, src/apps/web/x, /work/other/libs/nope."
    ].join("\n");

    // Act & Assert
    expect(candidateTopics({ text, root: ROOT, workspaceRepo: WS })).toEqual({
      repos: ["pcs-api", "ccd-data-store-api", "ccd-config-generator", "cnp-flux-config"],
      products: ["pcs", "ccd", "libs", "platops", "wa", "xui", "em"],
      tickets: [],
      workedIn: NONE_WORKED
    });
  });

  it("should put the session repo, cwd and branch before mentions and drop the workspace registration", () => {
    // Act
    const found = candidateTopics({
      workspaceRepo: WS,
      text: "see apps/ccd/ccd-data-store-api/x",
      cwd: "/work/hmcts/apps/dtsse/dtsse-agent-hub/src",
      repo: "dtsse-agent-hub",
      branch: "feature/VIBE-607-web-ui",
      root: ROOT
    });

    // Assert
    expect(found).toEqual({ repos: ["dtsse-agent-hub", "ccd-data-store-api"], products: ["dtsse", "ccd"], tickets: ["vibe-607"], workedIn: NONE_WORKED });
    expect(candidateTopics({ cwd: ROOT, repo: "cft-workspace", branch: "hdpi-77_retry", root: ROOT, workspaceRepo: WS })).toEqual({
      repos: [],
      products: [],
      tickets: ["hdpi-77"],
      workedIn: NONE_WORKED
    });
    expect(candidateTopics({ cwd: `${ROOT}/apps/ccd/docs`, root: ROOT, workspaceRepo: WS }).products).toEqual([]);
  });

  it("should read hmcts/ and github.com/hmcts/ references with their issue and PR numbers", () => {
    // Arrange
    const text = [
      "Cloned hmcts/cnp-api-docs and https://github.com/hmcts/pcs-frontend.git earlier.",
      "Fixes https://github.com/hmcts/cft-workspace/pull/52 and github.com/hmcts/pcs-api/issues/7; see hmcts/ccd-data-store-api#2114.",
      "Ignore /home/me/hmcts/apps/pcs, hmctsprod.azurecr.io/hmcts/pcs-api:1 and hmcts/apps."
    ].join("\n");

    // Act & Assert
    expect(candidateTopics({ text, root: ROOT, workspaceRepo: WS })).toEqual({
      repos: ["cnp-api-docs", "pcs-frontend", "pcs-api", "ccd-data-store-api"],
      products: [],
      tickets: ["cft-workspace-pr-52", "pcs-api-issue-7", "ccd-data-store-api-pr-2114"],
      workedIn: NONE_WORKED
    });
  });

  it("should lowercase Jira keys and skip standards and algorithms", () => {
    // Arrange
    const text = "HDPI-8713 is fixed; VIBE-607 next. Uses UTF-8, SHA-256, ISO-8601, AES-256, HTTP-2, TLS-1 and RFC-7231. HDPI-8713 again. lower-case-1 no.";

    // Act & Assert
    expect(candidateTopics({ text, root: ROOT }).tickets).toEqual(["hdpi-8713", "vibe-607"]);
    expect(candidateTopics({ branch: "feat/SHA-256-hash", root: ROOT }).tickets).toEqual([]);
  });

  it("should dedupe across sources and drop anything that is not a slug", () => {
    // Arrange
    const long = "a".repeat(60);
    const text = `apps/pcs/pcs-api/x hmcts/pcs-api apps/pcs/pcs-api/y hmcts/${long}#12345 apps/Weird_Name/Repo_X/z`;

    // Act
    const found = candidateTopics({ text, repo: "pcs-api", root: ROOT });

    // Assert
    expect(found.repos).toEqual(["pcs-api", "repo-x", long]);
    expect(found.products).toEqual(["pcs", "weird-name"]);
    expect(found.tickets).toEqual([]);
    for (const slug of [...found.repos, ...found.products, ...found.tickets]) {
      expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    }
  });

  it("should rank touched repos worked in first and keep cft-workspace out of clone-only work", () => {
    // Arrange
    const touches = touchesOf([
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/a" }),
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/b" }),
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/c" }),
      toolUse("Read", { file_path: "/work/cft-workspace/DOCS.md" }),
      toolUse("Bash", { command: "cd apps/dtsse/dtsse-agent-hub && yarn test" })
    ]);

    // Act
    const found = candidateTopics({
      text: "Fixed hmcts/cft-workspace#52 while in apps/pcs/pcs-api",
      touches,
      cwd: W,
      repo: "cft-workspace",
      branch: "feat/agent-hub",
      root: W,
      workspaceRepo: WS
    });

    // Assert
    expect(found.repos).toEqual(["dtsse-agent-hub", "ccd-data-store-api", "cft-workspace", "pcs-api"]);
    expect(found.workedIn).toEqual({ repos: ["dtsse-agent-hub"], products: ["dtsse"] });
    expect(found.products).toEqual(["dtsse", "ccd", "pcs"]);

    // Arrange
    const withScript = touchesOf([
      toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/a" }),
      toolUse("Bash", { command: "/work/cft-workspace/scripts/agent-hub status" })
    ]);
    const cloneOnly = touchesOf([toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/a" })]);

    // Act
    const clean = candidateTopics({ text: "see hmcts/cft-workspace", touches: cloneOnly, cwd: W, repo: "cft-workspace", root: W, workspaceRepo: WS });

    // Assert
    expect(clean.repos).toEqual(["dtsse-agent-hub"]);
    expect(candidateTopics({ touches: withScript, root: W, workspaceRepo: WS }).repos).toContain("cft-workspace");
  });
});
