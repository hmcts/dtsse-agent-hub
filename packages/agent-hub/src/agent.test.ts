// The session's identity on agent-hub: the workspace layout, the topics it joins by itself, the registration and
// the bridge process.
//
// The workspace suite's `agent.test.mjs` ended with "reconnect backoff doubles to a 60s ceiling", which drives
// `nextBackoff` from `bridge`; it is asserted in `bridge.test.ts`, beside the module it belongs to. The last
// case here is the one `skills.test.ts` points at.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { createMockHub } from "./__fixtures__/mock-hub.ts";
import {
  autoTopics,
  bridgePid,
  cloneDir,
  ensureBridge,
  gatherMetadata,
  gitBranch,
  jiraKey,
  loadAgent,
  normaliseTopic,
  normaliseTopics,
  parseAgent,
  registerAgent,
  repoName,
  slugify,
  stopBridge,
  touchPlace,
  workspacePlace,
  workspaceRepoName,
  workspaceRoot
} from "./agent.ts";
import { createApi } from "./api.ts";
import { ensureStateDir, readJson, statePath, writeJson } from "./session.ts";
import { skillsHash } from "./skills.ts";

const DEAD_PID = 999999999;

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};
const children: number[] = [];

function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeAll(() => {
  home = tempClaudeHome();
  setEnv("HOME", home.env.HOME);
  setEnv("CLAUDE_CONFIG_DIR", home.env.CLAUDE_CONFIG_DIR);
  // The workspace root every default-rooted lookup is taken from.
  setEnv("CLAUDE_PROJECT_DIR", home.root);
  setEnv("AGENT_HUB_CLAUDE_PID", undefined);
  setEnv("AGENT_HUB_CLI_JS", undefined);
});

afterAll(() => {
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  home.cleanup();
});

function gitRepo(dir: string, branch: string) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
}

// A worker that stays alive until it is killed, so a pid file can name a live process. It is awaited until it
// says it is ready, because a signal sent before it installed its handlers would prove nothing.
async function liveProcess(code: string): Promise<number> {
  const index = children.length;
  const file = path.join(home.root, `live-${index}.mjs`);
  const ready = path.join(home.root, `live-${index}.ready`);
  fs.writeFileSync(file, `import fs from "node:fs";\n${code}\nsetInterval(() => {}, 1000);\nfs.writeFileSync(${JSON.stringify(ready)}, "ok");\n`);
  const pid = Number(execFileSync("/bin/sh", ["-c", `${process.execPath} ${JSON.stringify(file)} >/dev/null 2>&1 & echo $!`], { encoding: "utf8" }).trim());
  children.push(pid);
  for (let i = 0; i < 400 && !fs.existsSync(ready); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return pid;
}

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("jiraKey", () => {
  it("should find a ticket in common branch shapes", () => {
    // Act & Assert
    expect(jiraKey("feature/HDPI-1234-fix-thing")).toBe("hdpi-1234");
    expect(jiraKey("hdpi-77_retry")).toBe("hdpi-77");
    expect(jiraKey("feat/agent-hub")).toBeNull();
    expect(jiraKey(null)).toBeNull();
  });
});

describe("normaliseTopic", () => {
  it("should lowercase and trim a slug, and refuse anything the hub would not take", () => {
    // Act & Assert
    expect(normaliseTopic(" PCS-API ")).toBe("pcs-api");
    expect(normaliseTopic("bad slug")).toBeNull();
    expect(normaliseTopic("-x")).toBeNull();
  });
});

describe("normaliseTopics", () => {
  it("should lowercase, split commas, dedupe and report bad slugs", () => {
    // Act & Assert
    expect(normaliseTopics(["PCS-API,ccd", "ccd", "bad slug", "-x"])).toEqual({ good: ["pcs-api", "ccd"], bad: ["bad slug", "-x"] });
  });

  it("should ignore an empty part when the list has a stray comma", () => {
    // Act & Assert
    expect(normaliseTopics(["ccd,,pcs-api,", " "])).toEqual({ good: ["ccd", "pcs-api"], bad: [] });
  });
});

describe("slugify", () => {
  it("should be null when nothing a topic could use is left", () => {
    // Act & Assert
    expect(slugify("---")).toBeNull();
  });
});

describe("autoTopics", () => {
  it("should use the repo name and Jira key", () => {
    // Act & Assert
    expect(autoTopics({ repo: "pcs.api", branch: "HDPI-9-x" })).toEqual(["pcs-api", "hdpi-9"]);
    expect(autoTopics({ repo: null, branch: null })).toEqual([]);
  });

  it("should add the workspace product of the cwd", () => {
    // Arrange
    const at = (rel: string) => path.join(home.root, rel);

    // Act & Assert
    expect(autoTopics({ repo: "pcs-api", branch: "HDPI-9-x", cwd: at("apps/pcs/pcs-api/src") })).toEqual(["pcs-api", "pcs", "hdpi-9"]);
    expect(autoTopics({ repo: "rse-cft-lib", branch: null, cwd: at("libs/rse-cft-lib") })).toEqual(["rse-cft-lib", "libs"]);
    expect(autoTopics({ repo: null, branch: null, cwd: home.root })).toEqual([]);
    expect(autoTopics({ repo: "x", branch: null, cwd: "/elsewhere/apps/pcs/x" })).toEqual(["x"]);
  });
});

describe("workspaceRoot", () => {
  it("should be the directory holding workspace.yaml, from the root and from inside a clone", () => {
    // Arrange
    const ws = path.join(home.root, "ws-manifest");
    const inClone = path.join(ws, "apps", "pcs", "pcs-api", "src", "main");
    fs.mkdirSync(inClone, { recursive: true });
    fs.writeFileSync(path.join(ws, "workspace.yaml"), "repos: []\n");

    // Act & Assert
    expect(workspaceRoot(ws)).toBe(ws);
    expect(workspaceRoot(inClone)).toBe(ws);
  });

  it("should fall back to the git toplevel, then to where it started, when there is no manifest", () => {
    // Arrange
    const repo = path.join(home.root, "ws-no-manifest");
    const inside = path.join(repo, "a", "b");
    fs.mkdirSync(inside, { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    const bare = path.join(home.root, "ws-nothing");
    fs.mkdirSync(bare, { recursive: true });

    // Act & Assert
    expect(workspaceRoot(inside)).toBe(fs.realpathSync(repo));
    expect(workspaceRoot(bare)).toBe(bare);
  });

  // `cd apps/pcs/pcs-api && claude` makes the clone the project directory, so rooting the layout there placed
  // nothing: the agent registered no repo, no branch and no topics.
  it("should let a session started inside a clone still register the clone and its topics", () => {
    // Arrange
    const ws = path.join(home.root, "ws-session");
    const clone = path.join(ws, "apps", "pcs", "pcs-api");
    fs.mkdirSync(path.join(clone, "src"), { recursive: true });
    fs.writeFileSync(path.join(ws, "workspace.yaml"), "repos: []\n");
    gitRepo(clone, "HDPI-9-rename");
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "git@github.com:hmcts/pcs-api.git"]);
    setEnv("CLAUDE_PROJECT_DIR", clone);

    // Act
    try {
      const meta = gatherMetadata("clone-session", { cwd: path.join(clone, "src") });

      // Assert
      expect(meta).toMatchObject({ repo: "pcs-api", branch: "HDPI-9-rename" });
      expect(autoTopics(meta)).toEqual(["pcs-api", "pcs", "hdpi-9"]);
      expect(workspaceRepoName()).toBe("ws-session");
      expect(touchPlace(path.join(clone, "src", "a.java"))).toEqual({ repo: "pcs-api", product: "pcs", dir: clone });
    } finally {
      setEnv("CLAUDE_PROJECT_DIR", home.root);
    }
  });
});

describe("workspacePlace", () => {
  it("should read the workspace layout", () => {
    // Act & Assert
    expect(workspacePlace("apps/ccd/ccd-data-store-api/src", "/r")).toEqual({ product: "ccd", repo: "ccd-data-store-api" });
    expect(workspacePlace("/r/platops/cnp-flux-config", "/r")).toEqual({ product: "platops", repo: "cnp-flux-config" });
    expect(workspacePlace("apps/ccd/docs/x.md", "/r")).toEqual({ product: "ccd", repo: null });
    expect(workspacePlace("apps/pcs", "/r")).toEqual({ product: "pcs", repo: null });
    expect(workspacePlace("libs", "/r")).toEqual({ product: "libs", repo: null });
    expect(workspacePlace("/other/apps/pcs/pcs-api", "/r")).toBeNull();
    expect(workspacePlace("scripts/agent-hub", "/r")).toBeNull();
  });

  it("should be null when it is given no path at all", () => {
    // Act & Assert
    expect(workspacePlace(null, "/r")).toBeNull();
    expect(workspacePlace("", "/r")).toBeNull();
  });

  it("should be null when the product directory does not slugify", () => {
    // Act & Assert
    expect(workspacePlace("apps/---/x", "/r")).toBeNull();
  });
});

describe("cloneDir", () => {
  it("should be the clone a workspace-relative path sits in, and null outside one", () => {
    // Act & Assert
    expect(cloneDir("apps/ccd/docs/x", "/r")).toBeNull();
    expect(cloneDir("platops/cnp-flux-config/apps", "/r")).toBe("/r/platops/cnp-flux-config");
  });
});

describe("touchPlace", () => {
  it("should map clones, workspace-owned files, and ignore the rest", () => {
    // Arrange
    const at = (p: string | null) => touchPlace(p, "/r", "cft-workspace");

    // Act & Assert
    expect(at("/r/apps/dtsse/dtsse-agent-hub/src/a.ts")).toEqual({ repo: "dtsse-agent-hub", product: "dtsse", dir: "/r/apps/dtsse/dtsse-agent-hub" });
    expect(at("/r/libs/rse-cft-lib")).toEqual({ repo: "rse-cft-lib", product: "libs", dir: "/r/libs/rse-cft-lib" });
    expect(at("/r/scripts/agent-hub")).toEqual({ repo: "cft-workspace", product: null, dir: "/r" });
    expect(at("/r/.claude/skills/x/SKILL.md")).toEqual({ repo: "cft-workspace", product: null, dir: "/r" });
    expect(at("/r/apps/ccd/docs/x.md")).toEqual({ repo: "cft-workspace", product: "ccd", dir: "/r" });
    expect(at("/r/apps/ccd/.claude/skills")).toEqual({ repo: "cft-workspace", product: "ccd", dir: "/r" });
    expect(at("/r/apps/ccd/CLAUDE.md")).toEqual({ repo: "cft-workspace", product: "ccd", dir: "/r" });
    for (const p of ["/r", "/r/apps", "/r/apps/ccd", "/r/libs", "/tmp/x", "/r-other/scripts", "scripts/x", null]) {
      expect(at(p), String(p)).toBeNull();
    }
  });

  it("should be null when the workspace repo itself has no name", () => {
    // Act & Assert
    expect(touchPlace("/r/scripts/agent-hub", "/r", null)).toBeNull();
    expect(touchPlace("/r/apps/ccd/CLAUDE.md", "/r", null)).toBeNull();
  });

  // With no manifest above it the root comes from the git toplevel, which git reports realpathed, while the
  // paths in the session's transcript keep the symlinked spelling the session used. Compared raw, every one of
  // them sat outside the root, so the stop worker saw no touches and offered no topics.
  it("should attribute a path under a symlinked root when no manifest sits above the session", () => {
    // Arrange
    const real = path.join(home.root, "ws-symlinked");
    const clone = path.join(real, "apps", "pcs", "pcs-api");
    fs.mkdirSync(path.join(clone, "src"), { recursive: true });
    gitRepo(real, "master");
    const link = path.join(home.root, "ws-through-a-link");
    fs.symlinkSync(real, link);

    // Act
    const root = workspaceRoot(path.join(link, "apps", "pcs"));
    const place = touchPlace(path.join(link, "apps", "pcs", "pcs-api", "src", "a.java"), root, "cft-workspace");

    // Assert
    expect(root).toBe(fs.realpathSync(real));
    expect(place).toEqual({ repo: "pcs-api", product: "pcs", dir: path.join(root, "apps", "pcs", "pcs-api") });
  });
});

describe("workspaceRepoName", () => {
  it("should fall back to the directory name and remember what it worked out", () => {
    // Arrange
    const root = path.join(home.root, "ws.cache");
    fs.mkdirSync(root, { recursive: true });

    // Act
    const first = workspaceRepoName(root);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "remote", "add", "origin", "git@github.com:hmcts/renamed.git"]);

    // Assert
    expect(first).toBe("ws-cache");
    expect(workspaceRepoName(root)).toBe("ws-cache");
  });
});

describe("repoName", () => {
  it("should be the origin remote's name without its .git suffix", () => {
    // Arrange
    const dir = path.join(home.root, "with-remote");
    gitRepo(dir, "master");
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:hmcts/pcs-api.git"]);

    // Act & Assert
    expect(repoName(dir)).toBe("pcs-api");
  });

  it("should fall back to the top-level directory when the clone has no remote", () => {
    // Arrange
    const dir = path.join(home.root, "no-remote");
    gitRepo(dir, "master");

    // Act & Assert
    expect(repoName(path.join(dir))).toBe("no-remote");
  });

  it("should be null outside a git repository", () => {
    // Act & Assert
    expect(repoName(path.join(home.root, "nowhere-at-all"))).toBeNull();
  });
});

describe("gitBranch", () => {
  it("should be the checked-out branch, and null on a detached HEAD or outside a repository", () => {
    // Arrange
    const dir = path.join(home.root, "branchy");
    gitRepo(dir, "feat/thing");

    // Act & Assert
    expect(gitBranch(dir)).toBe("feat/thing");
    execFileSync("git", ["-C", dir, "checkout", "-q", "--detach"]);
    expect(gitBranch(dir)).toBeNull();
    expect(gitBranch(path.join(home.root, "nowhere-at-all"))).toBeNull();
  });
});

describe("gatherMetadata", () => {
  it("should register no repo in the workspace, and the clone and its branch inside one", () => {
    // Arrange
    const root = path.join(home.root, "cft-workspace");
    gitRepo(root, "feat/agent-hub");
    const clone = path.join(root, "apps", "dtsse", "dtsse-agent-hub");
    gitRepo(clone, "VIBE-607-web-ui");
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(clone, "src"));

    // Act & Assert
    for (const cwd of [root, path.join(root, "scripts"), path.join(root, "apps", "dtsse")]) {
      const meta = gatherMetadata("sess-meta", { cwd, root });
      expect(meta.repo, cwd).toBeNull();
      expect(meta.branch, cwd).toBeNull();
      expect(meta.cwd).toBe(cwd);
      expect(autoTopics(meta)).not.toContain("cft-workspace");
    }
    const inClone = gatherMetadata("sess-meta", { cwd: path.join(clone, "src"), root });
    expect(inClone.repo).toBe("dtsse-agent-hub");
    expect(inClone.branch).toBe("VIBE-607-web-ui");
    expect(inClone.cwd).toBe(path.join(clone, "src"));
    expect(inClone.host).toBe(os.hostname());
    expect(inClone.session_id).toBe("sess-meta");
  });

  it("should fall back to the session's own working directory when none is given", () => {
    // Arrange
    fs.writeFileSync(path.join(home.claude, "sessions", "sess-meta-cwd.json"), JSON.stringify({ pid: DEAD_PID, sessionId: "sess-meta-cwd", cwd: home.root }));

    // Act & Assert
    expect(gatherMetadata("sess-meta-cwd").cwd).toBe(home.root);
  });

  it("should report no repository for a working directory that is not there any more", () => {
    // Act
    const meta = gatherMetadata("sess-meta", { cwd: path.join(home.root, "deleted-while-running"), root: home.root });

    // Assert
    expect(meta.repo).toBeNull();
    expect(meta.branch).toBeNull();
  });
});

describe("parseAgent", () => {
  it("should drop every field a saved agent did not write in the shape this client writes it", () => {
    // Act & Assert
    expect(parseAgent("not an object")).toBeNull();
    expect(parseAgent(["a"])).toBeNull();
    expect(parseAgent({ agent_id: 7, topics: ["a", 2], claude_pid: "x", repo: null })).toEqual({ topics: ["a"], claude_pid: null, repo: null });
    expect(parseAgent({ agent_id: "a-1", name: "me", session_id: "s", pending_subscribe: "nope" })).toEqual({
      agent_id: "a-1",
      name: "me",
      session_id: "s",
      claude_pid: null
    });
  });
});

describe("loadAgent", () => {
  it("should be null when there is no agent file, and the saved agent when there is", () => {
    // Arrange
    ensureStateDir("sess-load");
    writeJson(statePath("sess-load", "agent.json"), { agent_id: "a-1", name: "me", topics: ["pcs-api"] });

    // Act & Assert
    expect(loadAgent("sess-missing")).toBeNull();
    expect(loadAgent("sess-load")).toMatchObject({ agent_id: "a-1", name: "me", topics: ["pcs-api"] });
  });
});

describe("registerAgent", () => {
  it("should subscribe to the topics a handed-off session left behind and forget them once it has", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    const api = createApi({ baseUrl: url, devUser: "u-me|Me|me@example.com" });
    const sid = "sess-pending";
    ensureStateDir(sid);
    writeJson(statePath(sid, "agent.json"), { claude_pid: DEAD_PID, pending_subscribe: ["pcs-api", "ccd"], handed_off_from: "sess-old" });

    try {
      // Act
      const { agent } = await registerAgent(api, sid, { cwd: home.root, collectSkills: () => [] });

      // Assert
      expect([...(hub.subscriptions.get(agent.agent_id) ?? [])]).toEqual(["pcs-api", "ccd"]);
      expect(agent.pending_subscribe).toBeUndefined();
      expect(loadAgent(sid)).toMatchObject({ agent_id: agent.agent_id, session_id: sid, handed_off_from: "sess-old", claude_pid: DEAD_PID });
      expect(readJson(statePath(sid, "agent.json"))).not.toHaveProperty("pending_subscribe");
    } finally {
      await hub.close();
    }
  });

  it("should register with the conversation id, and keep it in agent.json, when AGENT_HUB_CONVERSATION_ID is set", async () => {
    // Arrange
    const launchToken = `launch-${"a".repeat(16)}`;
    const conversation = "0f8a6a1e-0000-4000-8000-000000000001";
    const hub = createMockHub({ launchTokens: { [launchToken]: { virtualId: "va-assist", owner: { oid: "oid-owner", name: "Olive Owner" } } } });
    const url = await hub.listen();
    const api = createApi({ baseUrl: url, launchToken });
    const registrations = () => hub.calls.filter((c) => c.path === "/api/agent/register");

    try {
      // Act
      await registerAgent(api, "conv-sess", { cwd: home.root, env: { AGENT_HUB_CONVERSATION_ID: conversation }, collectSkills: () => [] });

      // Assert
      expect(registrations()[0]?.body.conversation_id).toBe(conversation);
      expect(loadAgent("conv-sess")?.conversation_id).toBe(conversation);

      // Act
      await registerAgent(api, "plain-sess", { cwd: home.root, env: {}, collectSkills: () => [] });

      // Assert: the whitelist parser answers `undefined` for a field it did not read, so the file is what to check.
      expect(registrations()[1]?.body).not.toHaveProperty("conversation_id");
      expect(loadAgent("plain-sess")?.conversation_id).toBeUndefined();
      expect(readJson(statePath("plain-sess", "agent.json"))).not.toHaveProperty("conversation_id");
    } finally {
      await hub.close();
    }
  });

  it("should send the skills with the registration and remember their hash", async () => {
    // Arrange
    const hub = createMockHub();
    const url = await hub.listen();
    const api = createApi({ baseUrl: url, devUser: "u-me|Me|me@example.com" });
    const skills = [{ name: "cft-explain", description: "Explain" }];

    try {
      // Act
      const { agent } = await registerAgent(api, "skills-register", { cwd: home.root, collectSkills: () => skills });

      // Assert
      expect(hub.agents.get(agent.agent_id)?.skills).toEqual(skills);
      expect(loadAgent("skills-register")?.skills_hash).toBe(skillsHash(skills));
    } finally {
      await hub.close();
    }
  });
});

describe("bridgePid", () => {
  it("should be null when the pid file is missing or names a process that has gone", () => {
    // Arrange
    ensureStateDir("sess-bridge-pid");
    fs.writeFileSync(statePath("sess-bridge-pid", "bridge.pid"), `${DEAD_PID}\n`);

    // Act & Assert
    expect(bridgePid("sess-no-bridge")).toBeNull();
    expect(bridgePid("sess-bridge-pid")).toBeNull();
  });
});

describe("ensureBridge", () => {
  it("should start a bridge, clear any stop file and log the pid when none is running", async () => {
    // Arrange
    const sid = "sess-ensure-bridge";
    ensureStateDir(sid);
    fs.writeFileSync(statePath(sid, "bridge.stop"), "stop\n");
    const cli = path.join(home.root, "bridge-recorder.mjs");
    fs.writeFileSync(cli, 'process.stdout.write("bridge ran: " + process.argv.slice(2).join(" ") + "\\n");\n');

    // Act
    const { pid, started } = await ensureBridge(sid, { env: { ...process.env, AGENT_HUB_CLI_JS: cli } });

    // Assert
    expect(started).toBe(true);
    expect(pid).toBeGreaterThan(0);
    expect(fs.existsSync(statePath(sid, "bridge.stop"))).toBe(false);
    for (let i = 0; i < 100 && !fs.readFileSync(statePath(sid, "log"), "utf8").includes("bridge ran"); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const log = fs.readFileSync(statePath(sid, "log"), "utf8");
    expect(log).toMatch(new RegExp(`spawned bridge pid ${pid}`));
    expect(log).toContain(`bridge ran: bridge --session ${sid}`);
  });

  it("should leave a running bridge alone", async () => {
    // Arrange
    const sid = "sess-bridge-running";
    ensureStateDir(sid);
    fs.writeFileSync(statePath(sid, "bridge.pid"), `${process.pid}\n`);

    // Act & Assert
    expect(await ensureBridge(sid)).toEqual({ pid: process.pid, started: false });
  });
});

describe("stopBridge", () => {
  it("should write the stop file and report false when no bridge is running", async () => {
    // Arrange
    const sid = "sess-stop-none";

    // Act & Assert
    expect(await stopBridge(sid)).toBe(false);
    expect(fs.existsSync(statePath(sid, "bridge.stop"))).toBe(true);
  });

  it("should report true once the bridge it signalled has exited", async () => {
    // Arrange
    const sid = "sess-stop-live";
    ensureStateDir(sid);
    const pid = await liveProcess("");
    fs.writeFileSync(statePath(sid, "bridge.pid"), `${pid}\n`);

    // Act & Assert
    expect(await stopBridge(sid)).toBe(true);
    expect(exited(pid)).toBe(true);
  });

  it("should report false when the bridge is still running after the wait", async () => {
    // Arrange
    const sid = "sess-stop-stubborn";
    ensureStateDir(sid);
    const pid = await liveProcess('process.on("SIGTERM", () => {});');
    fs.writeFileSync(statePath(sid, "bridge.pid"), `${pid}\n`);

    // Act & Assert
    expect(await stopBridge(sid, { waitMs: 200 })).toBe(false);
    expect(exited(pid)).toBe(false);
  });
});
