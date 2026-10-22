import { describe, expect, it } from "vitest";
import { bashPaths, extractTouches, workedInRepos } from "./touches.ts";

const W = "/work/cft-workspace";
const WS = "cft-workspace";

const toolUse = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  ...extra,
  message: { content: [{ type: "tool_use", name, input }] }
});
const jsonlOf = (entries: unknown[]) => `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
const touchesOf = (entries: unknown[], root = W) => extractTouches(jsonlOf(entries), { root, workspaceRepo: WS });
const slugs = (list: { slug: string }[]) => list.map((e) => e.slug);

describe("bashPaths", () => {
  it("should follow cd, pushd and git -C and pick up absolute and workspace paths when reading a command", () => {
    // Act & Assert
    expect(bashPaths("cd apps/dtsse/dtsse-agent-hub && yarn test", W)).toEqual(["/work/cft-workspace/apps/dtsse/dtsse-agent-hub"]);
    expect(bashPaths("git -C platops/cnp-flux-config status", W)).toEqual([
      "/work/cft-workspace/platops/cnp-flux-config",
      "/work/cft-workspace/platops/cnp-flux-config"
    ]);
    expect(bashPaths("pushd /work/cft-workspace/libs/rse-cft-lib >/dev/null; ls src", W)).toEqual(["/work/cft-workspace/libs/rse-cft-lib"]);
    expect(bashPaths("cd apps/pcs && cd pcs-api && ls", W)).toEqual(["/work/cft-workspace/apps/pcs", "/work/cft-workspace/apps/pcs/pcs-api"]);
    expect(bashPaths('grep -r x apps/ccd/ccd-data-store-api "/work/cft-workspace/scripts/grep" --file=/work/cft-workspace/libs/a/b', W)).toEqual([
      "/work/cft-workspace/apps/ccd/ccd-data-store-api",
      "/work/cft-workspace/scripts/grep",
      "/work/cft-workspace/libs/a/b"
    ]);
    expect(bashPaths('cd "$(git rev-parse --show-toplevel)" && ls apps/pcs/pcs-api; cat ~/.claude/x $HOME/y', W)).toEqual([]);
  });
});

describe("extractTouches", () => {
  it("should weigh edits, Bash and reads and rank repos and products when the session used several tools", () => {
    // Act
    const t = touchesOf([
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/README.md" }),
      toolUse("Grep", { pattern: "x", path: "apps/ccd/ccd-data-store-api/src" }),
      toolUse("Glob", { pattern: "**/*.ts", path: "/work/cft-workspace/apps/ccd/ccd-data-store-api" }),
      toolUse("Read", { file_path: "/work/cft-workspace/apps/ccd/ccd-data-store-api/b" }),
      toolUse("Bash", { command: "git -C platops/cnp-flux-config status" }),
      toolUse("Edit", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/src/a.ts", old_string: "a", new_string: "b" }),
      toolUse("Write", { file_path: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub/src/b.ts", content: "x" }),
      toolUse("Bash", { command: "cd apps/dtsse/dtsse-agent-hub && yarn test" })
    ]);

    // Assert
    expect(t.repos).toEqual([
      { slug: "dtsse-agent-hub", weight: 8, workedIn: true, edited: true, dir: "/work/cft-workspace/apps/dtsse/dtsse-agent-hub", products: ["dtsse"] },
      { slug: "ccd-data-store-api", weight: 4, workedIn: false, edited: false, dir: "/work/cft-workspace/apps/ccd/ccd-data-store-api", products: [] },
      { slug: "cnp-flux-config", weight: 2, workedIn: true, edited: false, dir: "/work/cft-workspace/platops/cnp-flux-config", products: ["platops"] }
    ]);
    expect(t.products).toEqual([
      { slug: "dtsse", weight: 8, workedIn: true, edited: true },
      { slug: "ccd", weight: 4, workedIn: false, edited: false },
      { slug: "platops", weight: 2, workedIn: true, edited: false }
    ]);
  });

  it("should map workspace-owned paths to the workspace repo and ignore the rest when a turn ranges wider", () => {
    // Act
    const t = touchesOf([
      toolUse("Edit", { file_path: "/work/cft-workspace/apps/ccd/docs/x.md" }),
      toolUse("NotebookEdit", { notebook_path: "/work/cft-workspace/docs/n.ipynb" }),
      toolUse("MultiEdit", { file_path: "/work/cft-workspace/scripts/lib/agent-hub/agent.mjs" }),
      toolUse("Edit", { file_path: "/tmp/scratch.txt" }),
      toolUse("Write", { file_path: "/home/me/.claude/agent-hub/x" }),
      toolUse("Read", { file_path: W }),
      toolUse("Bash", { command: "cd /work/cft-workspace && ls /tmp" }),
      toolUse("Edit", { file_path: "/work/cft-workspace/apps/pcs/pcs-api/src/X.java" }, { isSidechain: true }),
      toolUse("TodoWrite", { todos: [] }),
      { type: "user", message: { content: [{ type: "tool_result", content: "/work/cft-workspace/apps/xui/rpx-xui-webapp" }] } }
    ]);

    // Assert
    expect(t.repos).toEqual([{ slug: "cft-workspace", weight: 9, workedIn: true, edited: true, dir: W, products: ["ccd"] }]);
    expect(slugs(t.products)).toEqual(["ccd"]);
  });
});

describe("workedInRepos", () => {
  it("should keep the workspace repo only when its own files were edited", () => {
    // Arrange: a Bash command run from the workspace root works in it, but does not change it.
    const ranAScript = touchesOf([toolUse("Bash", { command: "/work/cft-workspace/scripts/agent-hub status" })]);
    const editedIt = touchesOf([toolUse("Edit", { file_path: "/work/cft-workspace/scripts/lib/agent-hub/agent.mjs" })]);

    // Act & Assert
    expect(slugs(workedInRepos(ranAScript, WS))).toEqual([]);
    expect(slugs(workedInRepos(editedIt, WS))).toEqual([WS]);
    expect(workedInRepos(null, WS)).toEqual([]);
  });
});
