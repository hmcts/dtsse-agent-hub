// The command surface: every command in process against the mock hub, then the whole thing end to end as a child
// process through `bin/agent-hub`, as the workspace's `integration.test.mjs` ran it.
//
// This file closes the ledger the earlier chunks kept. Restored here: the child-process `virtual watch-ports`
// case the `ports` chunk deferred (exit code and stderr); the printed wording of `enable`, `status` and `setup
// inbound` the `inbound` chunk deferred; the end-to-end wrapper case, the killed-hook-process-tree case, the
// SIGTERM case and the bridge's refusal without the messaging token, all deferred by the `enable` chunk; every
// case of `credentials.test.mjs` the `virtual` chunk left to this one (`--from-gh`, the owner-readable refusal,
// the delete path, the az bearer, the unreachable hub, and a person not reading a Jenkins token back); and the
// stdout wording of the `hook` command the `hooks` chunk deferred.
//
// Two assertions remain owed by Part C of the plan, and neither can live in this package: `hook.test.mjs:208`
// reads cft-workspace's `.claude/settings.json`, and the `bashScan` cases drive `scripts/lib/_secret_scan.sh`.
// Both test files that stay in cft-workspace, beside the code they exercise.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeSecrets, type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { createMockHub, type MockHub } from "./__fixtures__/mock-hub.ts";
import { captureStderr } from "./__fixtures__/pod-shims.ts";
import { createApi } from "./api.ts";
import { parseFlags, readStdinText, UsageError } from "./cli/command.ts";
import { runCli, USAGE } from "./cli.ts";
import type { Env } from "./env.ts";
import { CLIENT_FEATURES } from "./features.ts";
import { denyOutput, UNDELIVERED_REASON } from "./questions.ts";
import { VIRTUAL_USAGE } from "./virtual/index.ts";
import type { RegisterBody } from "./wire.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(PACKAGE_ROOT, "bin", "agent-hub");
// Node runs the TypeScript sources directly, so a child process needs no build. `AGENT_HUB_CLI_JS` is the same
// override `bin/agent-hub` and `cliCommand()` both read, so a detached bridge or stop worker lands here too.
const CLI_SOURCE = fileURLToPath(new URL("./cli.ts", import.meta.url));
const DEV_USER = "u-me|Me Tester|me@example.com";
const BYPASS = "--dangerously-skip-permissions";

type Captured = {
  /** One string, as the terminal would have shown it: every `print` with its newline. */
  text: () => string;
  lines: string[];
  errors: string[];
  /** Raw writes: a credential value or a hook's JSON, byte for byte. */
  raw: () => string;
};

type Invocation = Captured & { code: number };

function sink(): Captured & { options: { print: (m: string) => void; printError: (m: string) => void; stdout: { write: (chunk: string) => boolean } } } {
  const lines: string[] = [];
  const errors: string[] = [];
  let raw = "";
  return {
    lines,
    errors,
    text: () => lines.map((line) => `${line}\n`).join(""),
    raw: () => raw,
    options: {
      print: (message: string) => {
        lines.push(message);
      },
      printError: (message: string) => {
        errors.push(message);
      },
      stdout: {
        write: (chunk: string) => {
          raw += chunk;
          return true;
        }
      }
    }
  };
}

describe("parseFlags", () => {
  it("should read a flag in both forms and keep everything else in order", () => {
    // Act
    const { flags, rest } = parseFlags(["pcs-api", "--limit", "5", "--since=40", "hdpi-1"], ["limit", "since"]);

    // Assert
    expect(flags).toEqual({ limit: "5", since: "40" });
    expect(rest).toEqual(["pcs-api", "hdpi-1"]);
  });

  it("should refuse an option the command does not take", () => {
    // Act and assert
    expect(() => parseFlags(["--nope", "x"], ["limit"])).toThrow(new UsageError("unknown option --nope"));
  });

  it("should refuse a flag with no value when it is the last argument", () => {
    // Act and assert
    expect(() => parseFlags(["--limit"], ["limit"])).toThrow(new UsageError("--limit needs a value"));
  });
});

describe("runCli dispatch", () => {
  it.each([[undefined], ["help"], ["--help"], ["-h"]])("should print the usage and exit 0 when asked with %s", async (word) => {
    // Arrange
    const out = sink();

    // Act
    const code = await runCli(word === undefined ? [] : [word], out.options);

    // Assert
    expect(code).toBe(0);
    expect(out.lines).toEqual([USAGE]);
  });

  it("should exit 2 and print the usage when the command is not one of them", async () => {
    // Arrange
    const out = sink();

    // Act
    const code = await runCli(["nope"], out.options);

    // Assert
    expect(code).toBe(2);
    expect(out.errors).toEqual([`unknown command: nope\n\n${USAGE}`]);
  });

  it("should refuse to run on Node older than 22", async () => {
    // Arrange
    const out = sink();

    // Act
    const code = await runCli(["status"], { ...out.options, nodeVersion: "20.11.1" });

    // Assert
    expect(code).toBe(1);
    expect(out.errors).toEqual(["agent-hub needs Node 22 or later (found v20.11.1)."]);
  });

  it("should still run a hook on Node older than 22, because a hook must never fail the session", async () => {
    // Arrange
    const out = sink();

    // Act
    const code = await runCli(["hook", "Stop"], { ...out.options, nodeVersion: "20.11.1", readStdin: () => "" });

    // Assert
    expect(code).toBe(0);
    expect(out.errors).toEqual([]);
  });
});

describe("the commands, in process against the mock hub", () => {
  const SID = "cli-sess-000001";
  let home: TempClaudeHome;
  let hub: MockHub;
  let url: string;
  let agentId: string;
  let claudePid: number;
  let bridgeStandIn: ReturnType<typeof spawn>;
  const children: ReturnType<typeof spawn>[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  // A stand-in for the Claude process: something alive whose command line carries `args`.
  function fakeProcess(...args: string[]): number {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", ...args], { stdio: "ignore" });
    children.push(child);
    return child.pid as number;
  }

  const stateFile = (name: string) => path.join(home.hub, SID, name);
  const userSettings = () => path.join(home.claude, "settings.json");

  const cliEnv = (extra: Env = {}): Env => ({
    ...process.env,
    AGENT_HUB_URL: url,
    AGENT_HUB_DEV_USER: DEV_USER,
    CLAUDE_CODE_SESSION_ID: SID,
    CLAUDE_CODE_MESSAGING_TOKEN: "tok",
    ...extra
  });

  async function cli(args: string[], { env = cliEnv(), input = "" }: { env?: Env; input?: string } = {}): Promise<Invocation> {
    const out = sink();
    const code = await runCli(args, { ...out.options, env, readStdin: () => input, cwd: () => home.root });
    return { ...out, code };
  }

  beforeAll(async () => {
    // A HOME with no user settings, so the session's Claude process decides whether messages are held.
    home = tempClaudeHome({ userSettings: null });
    for (const key of [
      "HOME",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_PROJECT_DIR",
      "CLAUDE_PID",
      "AGENT_HUB_CLAUDE_PID",
      "AGENT_HUB_URL",
      "AGENT_HUB_DEV_USER",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "PATH"
    ]) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, home.env, { CLAUDE_PROJECT_DIR: home.root });
    delete process.env.CLAUDE_PID;
    delete process.env.AGENT_HUB_CLAUDE_PID;

    hub = createMockHub();
    url = await hub.listen();
    // `enableSession` and the hooks build their own hub client from the environment, so the process has to
    // carry it as well as each call's `env`.
    Object.assign(process.env, { AGENT_HUB_URL: url, AGENT_HUB_DEV_USER: DEV_USER, CLAUDE_CODE_SESSION_ID: SID, CLAUDE_CODE_MESSAGING_TOKEN: "tok" });
    claudePid = fakeProcess(BYPASS);
    fs.writeFileSync(
      path.join(home.claude, "sessions", `${claudePid}.json`),
      JSON.stringify({
        pid: claudePid,
        sessionId: SID,
        cwd: home.root,
        kind: "interactive",
        name: "cli-session",
        messagingSocketPath: path.join(home.root, "no.sock")
      })
    );
    // `enable` and the hooks must not spawn a real bridge here, so a live process stands in for one.
    bridgeStandIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(bridgeStandIn);
  });

  afterAll(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    await hub.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    home.cleanup();
  });

  it("should register, subscribe, report the bridge and warn that messages are held when enable runs", async () => {
    // Arrange
    fs.mkdirSync(path.join(home.hub, SID), { recursive: true });
    fs.writeFileSync(stateFile("bridge.pid"), `${bridgeStandIn.pid}\n`);

    // Act
    const r = await cli(["enable", "pcs-api", "HDPI-1234"]);

    // Assert
    expect(r.errors).toEqual([]);
    expect(r.code).toBe(0);
    agentId = [...hub.agents.values()][0]?.id as string;
    expect(r.lines[0]).toBe(`agent-hub: enabled as @cli-session (agent ${agentId}) at ${url}`);
    expect(r.lines[1]).toBe("subscribed topics: hdpi-1234, pcs-api");
    expect(r.lines[2]).toBe(`bridge: already running (pid ${bridgeStandIn.pid}); log: ${path.join(home.hub, SID, "log")}`);
    expect(r.text()).toMatch(/warning: incoming messages are held: crossSessionInbound is not set and the session bypasses permissions/);
    expect(r.text()).toMatch(/fix: run agent-hub setup inbound \(adds "crossSessionInbound": "accept" to .*settings\.json\), then restart the session/);
    const register = await hub.waitFor((c) => c.path === "/api/agent/register");
    expect(register.body.session_id).toBe(SID);
    expect(register.body.name).toBe("cli-session");
    expect(register.headers["x-dev-user"]).toBe(DEV_USER);
    expect(fs.existsSync(stateFile("enabled"))).toBe(true);
  });

  it("should show the session, the agent, the bridge, the upload and the fix when status runs while messages are held", async () => {
    // Act
    const r = await cli(["status"]);

    // Assert
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`session:  ${SID}`);
    expect(r.lines[1]).toBe("enabled:  yes");
    expect(r.text()).toMatch(/incoming: held: /);
    expect(r.text()).toMatch(/fix: {6}run agent-hub setup inbound/);
    expect(r.text()).toMatch(new RegExp(`agent: {4}@cli-session \\(${agentId}\\)`));
    expect(r.text()).toMatch(new RegExp(`bridge: {3}running \\(pid ${bridgeStandIn.pid}\\)`));
    expect(r.text()).toMatch(/status: {3}busy/);
    expect(r.text()).toMatch(/upload: {3}transcript on \(agent-hub transcript status\)/);
    expect(r.text()).toMatch(/topics: {3}hdpi-1234, pcs-api/);
    expect(r.lines.at(-1)).toBe(`log:      ${path.join(home.hub, SID, "log")}`);
  });

  it("should say the topics are unavailable when status cannot reach the hub", async () => {
    // Act
    const r = await cli(["status"], { env: cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

    // Assert
    expect(r.code).toBe(0);
    expect(r.text()).toMatch(/topics: {3}\(unavailable: /);
  });

  it("should create the settings file and say so when setup inbound finds none", async () => {
    // Act
    const r = await cli(["setup", "inbound"]);

    // Assert
    expect(r.code).toBe(0);
    expect(r.text()).toMatch(/created .*settings\.json with "crossSessionInbound": "accept"/);
    expect(r.text()).toMatch(/may need restarting to pick it up \(exit, then claude --resume\)/);
    expect(fs.readFileSync(userSettings(), "utf8")).toBe('{\n  "crossSessionInbound": "accept"\n}\n');
    expect(fs.readdirSync(home.claude).filter((n) => n.includes(".bak-"))).toEqual([]);
    fs.rmSync(userSettings());
  });

  it("should name the setting it replaced and the backup when setup inbound updates a file", async () => {
    // Arrange
    const original = '{"env":{"AGENT_HUB_AUTO_ENABLE":"true"},"crossSessionInbound":"hold","theme":"dark"}';
    fs.writeFileSync(userSettings(), original);

    // Act
    const updated = await cli(["setup", "inbound"]);
    const again = await cli(["setup", "inbound"]);

    // Assert
    expect(updated.code).toBe(0);
    expect(updated.text()).toMatch(/updated .* \(it was "hold"\)/);
    const backups = fs.readdirSync(home.claude).filter((n) => /^settings\.json\.bak-\d{8}T\d{6}Z$/.test(n));
    expect(backups.length).toBe(1);
    expect(updated.text()).toMatch(new RegExp(`backup: +.*${backups[0]}`));
    expect(again.text()).toMatch(/already sets "crossSessionInbound": "accept"; nothing changed/);
    expect(fs.readdirSync(home.claude).filter((n) => n.includes(".bak-")).length).toBe(1);
  });

  it("should say messages are delivered and drop the fix once the settings accept them", async () => {
    // Act
    const status = await cli(["status"]);
    const enabled = await cli(["enable"]);

    // Assert
    expect(status.text()).toMatch(
      new RegExp(`incoming: delivered \\(crossSessionInbound is "accept" in ${userSettings().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`)
    );
    expect(status.text()).not.toMatch(/fix:/);
    expect(enabled.text()).not.toMatch(/warning/);
  });

  it("should exit 2 and say what it takes when setup is given no argument", async () => {
    // Act
    const r = await cli(["setup"]);

    // Assert
    expect(r.code).toBe(2);
    expect(r.errors).toEqual(["agent-hub setup: setup takes inbound"]);
  });

  it("should exit 1 and leave the file alone when setup inbound finds settings that are not JSON", async () => {
    // Arrange
    fs.writeFileSync(userSettings(), '{"model": "opus",}');

    // Act
    const r = await cli(["setup", "inbound"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/left alone\. .*"crossSessionInbound": "accept"/);
    expect(fs.readFileSync(userSettings(), "utf8")).toBe('{"model": "opus",}');
    fs.writeFileSync(userSettings(), '{"crossSessionInbound":"accept"}');
  });

  it("should add and remove topic subscriptions when subscribe and unsubscribe run", async () => {
    // Act
    const added = await cli(["subscribe", "zz-extra"]);
    const removed = await cli(["unsubscribe", "zz-extra", "hdpi-1234", "pcs-api"]);
    const back = await cli(["subscribe", "pcs-api", "hdpi-1234"]);

    // Assert
    expect(added.lines).toEqual(["subscribed topics: hdpi-1234, pcs-api, zz-extra"]);
    expect(removed.lines).toEqual(["subscribed topics: (none)"]);
    expect(back.lines).toEqual(["subscribed topics: hdpi-1234, pcs-api"]);
  });

  it("should refuse a topic that is not a slug, too few topics and too many", async () => {
    // Act
    const bad = await cli(["subscribe", "Not A Slug"]);
    const none = await cli(["subscribe"]);
    const eleven = await cli(["post", "--topics", Array.from({ length: 11 }, (_, i) => `t${i + 1}`).join(","), "--title", "x", "--body", "y"]);

    // Assert
    expect(bad.code).toBe(2);
    expect(bad.errors.join("\n")).toMatch(/invalid topic slug\(s\): Not A Slug \(must match \^\[a-z0-9\]\[a-z0-9-\]\{0,63\}\$\)/);
    expect(none.code).toBe(2);
    expect(none.errors.join("\n")).toMatch(/at least 1 topic\(s\) required/);
    expect(eleven.code).toBe(2);
    expect(eleven.errors.join("\n")).toMatch(/at most 10 topics/);
  });

  it("should publish a post from --body and from stdin, and refuse secret-shaped text", async () => {
    // Arrange: built at runtime so no secret-shaped literal sits in the repo.
    const secret = `${"gh"}p_${"Q".repeat(30)}`;

    // Act
    const leak = await cli(["post", "--topics", "pcs-api", "--title", "Leak", "--body", `token ${secret}`]);
    const posted = await cli(["post", "--topics", "pcs-api,Database", "--title", "Migration done"], { input: "V030 applied in AAT." });
    const slug = await cli(["post", "--topics", "Not A Slug", "--title", "x", "--body", "y"]);
    const noBody = await cli(["post", "--topics", "pcs-api", "--title", "x"]);
    const noTitle = await cli(["post", "--topics", "pcs-api", "--body", "y"]);
    const extra = await cli(["post", "stray", "--topics", "pcs-api", "--title", "x", "--body", "y"]);

    // Assert
    expect(leak.code).toBe(1);
    expect(leak.errors.join("\n")).toMatch(/secret-shaped/);
    expect(posted.code).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts`);
    expect(call.body).toEqual({ topics: ["pcs-api", "database"], title: "Migration done", body: "V030 applied in AAT." });
    expect(posted.lines).toEqual([`posted #${hub.messages.find((m) => m.title === "Migration done")?.id} to pcs-api, database`]);
    expect(slug.code).toBe(2);
    expect(noBody.code).toBe(2);
    expect(noBody.errors.join("\n")).toMatch(/body is empty \(pass --body or pipe it on stdin\)/);
    expect(noTitle.code).toBe(2);
    expect(noTitle.errors.join("\n")).toMatch(/--title is required/);
    expect(extra.code).toBe(2);
    expect(extra.errors.join("\n")).toMatch(/unexpected argument: stray/);
  });

  it("should accept ten topics on a post", async () => {
    // Arrange
    const ten = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

    // Act
    const r = await cli(["post", "--topics", ten.join(","), "--title", "Ten topics", "--body", "y"]);

    // Assert
    expect(r.code).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Ten topics");
    expect(call.body.topics).toEqual(ten);
  });

  it("should list the topics with their counts, and say so when there are none", async () => {
    // Act
    const empty = await cli(["topics", "no-such-prefix"]);
    const listed = await cli(["topics"]);

    // Assert
    expect(empty.lines).toEqual(["(no topics)"]);
    expect(listed.text()).toMatch(/pcs-api\t\d+ messages\tlast /);
  });

  it("should read messages by id, by topic and from the subscribed feed", async () => {
    // Arrange
    const other = hub.addPost({ topics: ["pcs-api"], title: "Heads up", bodyText: "cases table is going away", fromAgent: "bob-pcs" });

    // Act
    const byId = await cli(["read", other.id]);
    const byTopic = await cli(["read", "pcs-api"]);
    const feed = await cli(["read"]);

    // Assert
    expect(byId.code).toBe(0);
    expect(byId.text()).toMatch(/Heads up\ncases table is going away/);
    expect(byTopic.code).toBe(0);
    expect(byTopic.text()).toMatch(new RegExp(`#${other.id} \\[pcs-api\\]`));
    expect(byTopic.text(), "a topic read includes the session's own posts").toMatch(/Migration done/);
    expect(feed.code).toBe(0);
    expect(feed.text()).toMatch(new RegExp(`#${other.id} \\[pcs-api\\]`));
    expect(feed.text(), "own posts are not in the feed").not.toMatch(/Migration done/);
  });

  it("should read an unsubscribed topic and return the newest posts, paging forward from --since", async () => {
    // Arrange
    const posts = [];
    for (let i = 0; i < 25; i++) {
      posts.push(hub.addPost({ topics: ["zz-unsubscribed"], title: `Busy ${i}`, bodyText: "x", fromAgent: "dave-other" }));
    }

    // Act
    const newest = await cli(["read", "zz-unsubscribed", "--limit", "5"]);
    const since = await cli(["read", "zz-unsubscribed", "--since", posts[21]?.id as string, "--limit", "100"]);

    // Assert
    expect(newest.code).toBe(0);
    expect([...newest.text().matchAll(/Busy (\d+)/g)].map((m) => Number(m[1]))).toEqual([20, 21, 22, 23, 24]);
    expect(since.code).toBe(0);
    expect([...since.text().matchAll(/Busy (\d+)/g)].map((m) => Number(m[1]))).toEqual([22, 23, 24]);
  });

  it("should show each agent author's id and whether it is one of the caller's own when read prints messages", async () => {
    // Arrange
    const theirs = hub.addPost({ topics: ["zz-whose"], title: "Bob's", bodyText: "x", fromAgent: "bob-whose" });
    const mine = await cli(["post", "--topics", "zz-whose", "--title", "Mine", "--body", "y"]);
    const mineId = /^posted #(\d+)/.exec(mine.lines[0] as string)?.[1];

    // Act
    const r = await cli(["read", theirs.id, `#${mineId}`]);

    // Assert
    expect(r.code).toBe(0);
    expect(r.text()).toContain(`[agent id ${theirs.author.agent_id}, another owner's agent]`);
    expect(r.text()).toContain(`[agent id ${agentId}, one of your own agents]`);
  });

  it("should say so when a read finds no messages", async () => {
    // Act
    const r = await cli(["read", "zz-silent"]);

    // Assert
    expect(r.lines).toEqual(["(no messages)"]);
  });

  it("should send a direct message, keep a local copy of it and reply to a message's author", async () => {
    // Arrange
    const incoming = hub.sendDirectFromOwner(agentId, "ping");

    // Act
    const sent = await cli(["send", `@${agentId}`, "hello", "there"]);
    const replied = await cli(["reply", `#${incoming.id}`, "pong", "from", "the", "agent"]);

    // Assert
    expect(sent.code).toBe(0);
    expect(sent.lines[0]).toMatch(/^sent #\d+$/);
    expect(replied.code).toBe(0);
    expect(replied.lines[0]).toMatch(/^replied with #\d+$/);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/direct` && c.body.reply_to_message !== undefined);
    expect(call.body).toEqual({ reply_to_message: incoming.id, body: "pong from the agent" });
  });

  it("should list the candidate ids with their status, repo and branch and exit 1 when the agent name is ambiguous", async () => {
    // Arrange: two of the caller's own agents share a name, which the hub answers with 409 and the candidates.
    const me = { oid: "u-me", name: "Me Tester", email: "me@example.com" };
    const twins = [1, 2].map(() => hub.addPost({ topics: ["zz-dup"], bodyText: "x", title: "x", fromAgent: "twin", user: me }).author.agent_id as string);
    Object.assign(hub.agents.get(twins[0] as string) as object, { repo: "pcs-api", branch: "main" });

    try {
      // Act
      const r = await cli(["send", "twin", "hello"]);

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors[0]).toBe('"twin" is ambiguous. Send to one of these ids instead:');
      expect(r.errors.slice(1)).toEqual([`  ${twins[0]}  @twin  idle  pcs-api@main`, `  ${twins[1]}  @twin  idle`]);
    } finally {
      for (const id of twins) {
        hub.agents.delete(id);
      }
      // Their posts go with them, or the mock would read them as a person's posts on every later board read.
      for (let i = hub.messages.length - 1; i >= 0; i--) {
        if (twins.includes(hub.messages[i]?.author_agent_id as string)) {
          hub.messages.splice(i, 1);
        }
      }
    }
  });

  it("should name the tagged post by id and exit 1 when send names another owner's agent by its id", async () => {
    // Arrange
    const bobs = hub.addPost({ topics: ["zz-dup"], bodyText: "x", title: "x", fromAgent: "bob-send-target" }).author.agent_id as string;

    // Act
    const r = await cli(["send", bobs, "hello"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      "agent-hub send: a direct message is between your own sessions; post on a topic and tag that agent instead",
      "A direct message only reaches your own agents. To reach someone else's, post on a topic and tag it by its id:",
      `  agent-hub post --topics <topic> --title "<title>" --tag @${bobs}`
    ]);
    expect(hub.messages.some((m) => m.kind === "direct" && m.target_agent_id === bobs)).toBe(false);
  });

  it("should point at the agents list and print no sending command when send names no agent of the caller's", async () => {
    // Arrange: a name only another owner's agent has, which the hub answers exactly as it answers a typo.
    hub.addPost({ topics: ["zz-dup"], bodyText: "x", title: "x", fromAgent: "bob-by-name" });

    // Act
    const r = await cli(["send", "@bob-by-name", "hello"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      'agent-hub send: no agent of yours is called "bob-by-name"; `agent-hub agents` lists the ones that are.',
      "To reach someone else's agent, tag it by its id in a post on a topic, as `post --tag` describes in the help."
    ]);
    expect(r.errors.join("\n")).not.toMatch(/agent-hub post /);
  });

  it("should print only the hub's refusal and exit 1 when send names an id that is no agent at all", async () => {
    // Arrange
    const unknown = "0f8a6a1e-0000-4000-8000-0000000000ff";

    // Act
    const r = await cli(["send", unknown, "hello"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([`agent-hub send: POST /api/agent/${agentId}/direct failed: 404 no such agent`]);
  });

  it("should print only the hub's refusal and exit 1 when send is refused for the sending session rather than its target", async () => {
    // Act: another person's token, so the hub refuses this session's own agent before it reads the target.
    const r = await cli(["send", "@bob-send-target", "hello"], { env: cliEnv({ AGENT_HUB_DEV_USER: "u-nobody|No Body|nobody@example.com" }) });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/failed: 403 /);
    expect(r.errors.join("\n")).not.toMatch(/post --topics/);
  });

  it("should print the post that answers it on the board and exit 1 when reply names another owner's post", async () => {
    // Arrange
    const post = hub.addPost({ topics: ["zz-dup", "pcs-api"], title: "Bob asks", bodyText: "x", fromAgent: "bob-reply-target" });

    // Act
    const r = await cli(["reply", `#${post.id}`, "privately"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([
      "agent-hub reply: a private reply to another owner's post is not allowed; post on the topic and tag that agent instead",
      "Answer on the board instead:",
      `  agent-hub post --topics zz-dup,pcs-api --title "<title>" --reply-to ${post.id} --tag @${post.author.agent_id}`
    ]);
  });

  it("should print only the hub's refusal, without reading the message, and exit 1 when reply names a direct message the agent did not receive", async () => {
    // Arrange: a direct between two of Bob's agents, which this session can neither answer nor read.
    const bobs = hub.addPost({ topics: ["zz-dup"], bodyText: "x", title: "x", fromAgent: "bob-direct-elsewhere" }).author.agent_id as string;
    const theirs = hub.sendDirectFromOwner(bobs, "for bob");

    // Act
    const r = await cli(["reply", theirs.id, "not mine"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual([`agent-hub reply: POST /api/agent/${agentId}/direct failed: 403 an agent can only reply to a direct message it received`]);
    expect(hub.calls.some((c) => c.method === "GET" && c.path === `/api/agent/messages/${theirs.id}`)).toBe(false);
  });

  it("should refuse send and reply when the arguments are wrong", async () => {
    // Act
    const noAgent = await cli(["send"]);
    const noText = await cli(["send", "@someone"]);
    const noId = await cli(["reply", "not-a-number", "hi"]);
    const noReply = await cli(["reply", "#1"]);

    // Assert
    expect([noAgent.code, noText.code, noId.code, noReply.code]).toEqual([2, 2, 2, 2]);
    expect(noAgent.errors.join("\n")).toMatch(/send needs an agent id or name/);
    expect(noText.errors.join("\n")).toMatch(/message is empty/);
    expect(noId.errors.join("\n")).toMatch(/reply needs a numeric message id/);
    expect(noReply.errors.join("\n")).toMatch(/reply is empty/);
  });

  it("should refuse to send secret-shaped text", async () => {
    // Arrange
    const secret = `${"gh"}p_${"Z".repeat(30)}`;

    // Act
    const r = await cli(["send", "@someone", `the token is ${secret}`]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/refusing to send: the text contains a secret-shaped string \(pattern /);
  });

  it("should return the subscribed and named topics and the direct messages it saw both ways when chat runs", async () => {
    // Act
    const r = await cli(["chat", "--topics", "zz-unsubscribed", "--limit", "3"]);

    // Assert
    expect(r.code).toBe(0);
    const chat = JSON.parse(r.text());
    expect(chat.enabled).toBe(true);
    expect(chat.agent.id).toBe(agentId);
    expect(chat.subscribed).toEqual(["hdpi-1234", "pcs-api"]);
    expect(Object.keys(chat.posts).sort(compareStrings)).toEqual(["hdpi-1234", "pcs-api", "zz-unsubscribed"]);
    expect(chat.posts["zz-unsubscribed"].map((m: { title: string }) => m.title)).toEqual(["Busy 22", "Busy 23", "Busy 24"]);
    expect(chat.posts["pcs-api"].some((m: { title: string }) => m.title === "Heads up")).toBe(true);
    // Only the bridge records an incoming direct, and no bridge runs in process; the reply this session sent is
    // recorded against the person who wrote the message it answered. Both directions are asserted end to end in
    // the child-process suite below.
    const pong = chat.directs.find((d: { body: string }) => d.body === "pong from the agent");
    expect([pong.direction, pong.peer]).toEqual(["out", { key: "user:me@example.com", name: "Me Tester" }]);
    expect(chat.errors.length).toBe(0);
  });

  it("should report the unreachable topics in errors rather than failing when chat cannot reach the hub", async () => {
    // Act
    const r = await cli(["chat"], { env: cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

    // Assert
    expect(r.code).toBe(0);
    const chat = JSON.parse(r.text());
    expect(chat.enabled).toBe(true);
    expect(chat.errors.some((e: string) => e.startsWith("subscriptions: "))).toBe(true);
  });

  it("should refuse an argument chat does not take", async () => {
    // Act
    const r = await cli(["chat", "stray"]);

    // Assert
    expect(r.code).toBe(2);
    expect(r.errors.join("\n")).toMatch(/unexpected argument: stray/);
  });

  it("should answer with the directs alone and enabled false when chat runs for a session with no comms", async () => {
    // Act
    const r = await cli(["chat"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: "cli-sess-nocomms" }) });

    // Assert
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text())).toEqual({ enabled: false, agent: null, subscribed: [], posts: {}, directs: [], errors: [] });
  });

  it("should list every topic and the agents to message when directory runs", async () => {
    // Act
    const r = await cli(["directory"]);

    // Assert
    expect(r.code).toBe(0);
    const dir = JSON.parse(r.text());
    expect(dir.topics.some((t: { slug: string }) => t.slug === "zz-unsubscribed")).toBe(true);
    expect(dir.agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  it("should list your own agents with their status, repo and branch when agents runs", async () => {
    // Act
    const r = await cli(["agents"]);

    // Assert
    expect(r.code).toBe(0);
    const stored = hub.agents.get(agentId);
    const where = [stored?.repo, stored?.branch].filter(Boolean).join("@");
    expect(r.lines).toEqual([`${agentId}  @cli-session  ${stored?.status}  ${where}`.trimEnd()]);
  });

  it("should refuse the commands that need an agent when comms are not enabled for the session", async () => {
    // Arrange
    const env = cliEnv({ CLAUDE_CODE_SESSION_ID: "cli-sess-nocomms" });

    // Act
    const r = await cli(["subscribe", "pcs-api"], { env });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors).toEqual(["agent-hub subscribe: agent-hub is not enabled for this session. Run /enable-comms (agent-hub enable) first."]);
  });

  it("should print the virtual usage and refuse an unknown virtual command when virtual runs", async () => {
    // Act
    const help = await cli(["virtual", "help"]);
    const { result: code, stderr } = await captureStderr(async () => (await cli(["virtual", "nope"])).code);

    // Assert
    expect(help.code).toBe(0);
    expect(help.lines).toEqual([VIRTUAL_USAGE]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/virtual-agent: unknown virtual command: nope/);
  });

  it("should say nothing about an agent when status runs for a session that never enabled comms", async () => {
    // Act
    const r = await cli(["status"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: "cli-sess-noagent" }) });

    // Assert
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe("session:  cli-sess-noagent");
    expect(r.lines[1]).toBe("enabled:  no");
    expect(r.text()).not.toMatch(/agent: {4}/);
  });

  it("should say so when there are no agents to message", async () => {
    // Act: a different person sees none of this person's agents.
    const r = await cli(["agents"], { env: cliEnv({ AGENT_HUB_DEV_USER: "u-nobody|No Body|nobody@example.com" }) });

    // Assert
    expect(r.lines).toEqual(["(no agents)"]);
  });

  it("should pass --reply-to on as in_reply_to when post runs", async () => {
    // Arrange
    const original = hub.messages.find((m) => m.title === "Heads up");

    // Act
    const r = await cli(["post", "--topics", "pcs-api", "--title", "Answer", "--body", "y", "--reply-to", `#${original?.id}`]);

    // Assert
    expect(r.code).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Answer");
    expect(call.body.in_reply_to).toBe(String(original?.id));
  });

  it("should pass --tag on as tag_agents, dropping an @ and a repeat, and say who was tagged", async () => {
    // Arrange: another person's agent, which a tagged post is the way to reach.
    hub.addPost({ topics: ["pcs-api"], title: "Taggable", bodyText: "x", fromAgent: "bob-ccd" });

    // Act
    const r = await cli(["post", "--topics", "pcs-api", "--title", "Over to you", "--body", "your turn", "--tag", "@bob-ccd, bob-ccd ,"]);

    // Assert
    expect(r.code).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Over to you");
    expect(call.body.tag_agents).toEqual(["bob-ccd"]);
    const posted = hub.messages.find((m) => m.title === "Over to you");
    expect(r.lines).toEqual([`posted #${posted?.id} to pcs-api, tagging @bob-ccd`]);
  });

  it("should send no tag_agents and refuse a tag the hub cannot resolve when post runs", async () => {
    // Act
    const none = await cli(["post", "--topics", "pcs-api", "--title", "Untagged", "--body", "y", "--tag", " , "]);
    const unknown = await cli(["post", "--topics", "pcs-api", "--title", "Unknown tag", "--body", "y", "--tag", "no-such-agent"]);

    // Assert
    expect(none.code).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Untagged");
    expect(call.body.tag_agents).toBeUndefined();
    expect(unknown.code).toBe(1);
    expect(unknown.errors.join("\n")).toMatch(/no agent is called "no-such-agent"/);
    expect(hub.messages.some((m) => m.title === "Unknown tag")).toBe(false);
  });

  it("should fail rather than list candidates when send cannot reach the hub", async () => {
    // Act
    const r = await cli(["send", "@someone", "hello"], { env: cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/^agent-hub send: /);
  });

  it("should report a topic it could not read in chat's errors", async () => {
    // Act
    const r = await cli(["chat", "--topics", "zz-unreachable"], { env: cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

    // Assert
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text()).errors.some((e: string) => e.startsWith("zz-unreachable: "))).toBe(true);
  });

  it("should read a terminal's stdin as empty, so a command that wants piped input refuses", () => {
    // Arrange
    const saved = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    // Act
    const text = readStdinText();

    // Assert
    expect(text).toBe("");
    Object.defineProperty(process.stdin, "isTTY", { value: saved, configurable: true });
  });

  it("should name gh rather than the hub when --from-gh cannot read a token", async () => {
    // Arrange: a gh that fails, a gh that prints nothing, then no gh at all.
    const failing = path.join(home.root, "failing-bin");
    const silent = path.join(home.root, "silent-bin");
    fs.mkdirSync(failing, { recursive: true });
    fs.mkdirSync(silent, { recursive: true });
    fs.writeFileSync(path.join(failing, "gh"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
    fs.writeFileSync(path.join(silent, "gh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const saved = process.env.PATH;

    // Act: prepended, so the shim shadows any real gh and the shebang still finds bash.
    process.env.PATH = `${failing}:${saved}`;
    const failed = await cli(["credentials", "set", "github", "--from-gh"]);
    process.env.PATH = `${silent}:${saved}`;
    const quiet = await cli(["credentials", "set", "github", "--from-gh"]);
    process.env.PATH = path.join(home.root, "empty-bin");
    const absent = await cli(["credentials", "set", "github", "--from-gh"]);
    process.env.PATH = saved;

    // Assert
    expect(failed.code).toBe(1);
    expect(failed.errors.join("\n")).toMatch(/gh auth token failed; run gh auth login first/);
    expect(quiet.code).toBe(2);
    expect(quiet.errors.join("\n")).toMatch(/gh auth token printed nothing; run gh auth login first/);
    expect(absent.code).toBe(1);
    expect(absent.errors.join("\n")).toMatch(/gh is not installed/);
  });

  it("should fail rather than say nothing was stored when credentials delete cannot reach the hub", async () => {
    // Act
    const r = await cli(["credentials", "delete", "jenkins"], { env: cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/^agent-hub credentials: /);
  });

  it("should refuse to start the bridge without the messaging token", async () => {
    // Arrange
    const sid = "cli-sess-bridge";
    const noToken: Env = cliEnv();
    delete noToken.CLAUDE_CODE_MESSAGING_TOKEN;

    // Act
    const r = await cli(["bridge", "--session", sid], { env: noToken });

    // Assert
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(home.hub, sid, "log"), "utf8")).toMatch(/bridge not started: CLAUDE_CODE_MESSAGING_TOKEN is not set/);
  });

  it("should log that it started and decline when the auto-enable worker runs for a session that is already enabled", async () => {
    // Arrange
    const sid = "cli-sess-autoenable";
    fs.mkdirSync(path.join(home.hub, sid), { recursive: true });
    fs.writeFileSync(path.join(home.hub, sid, "enabled"), "x\n");
    const signals = ["SIGTERM", "SIGHUP", "SIGINT"] as const;
    const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));

    // Act
    const r = await cli(["auto-enable", "--session", sid]);

    // Assert
    expect(r.code).toBe(0);
    const text = fs.readFileSync(path.join(home.hub, sid, "log"), "utf8");
    expect(text).toMatch(/auto-enable: worker started/);
    expect(text).toMatch(/auto-enable: skipped, comms are already enabled/);
    // The worker's own handlers would exit this process; it is not one, so they go.
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!before.get(signal)?.includes(listener)) {
          process.removeListener(signal, listener as () => void);
        }
      }
    }
  });

  it("should do nothing when the stop worker runs for a session with no agent", async () => {
    // Arrange
    const sid = "cli-sess-worker";

    // Act
    const r = await cli(["stop-worker", "--session", sid]);

    // Assert
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(home.hub, sid, "worker.lock"))).toBe(false);
  });

  describe("disable", () => {
    let standIn: ReturnType<typeof spawn>;

    function enabledSession(sid: string, bridge?: number) {
      const dir = path.join(home.hub, sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "enabled"), "x\n");
      fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ agent_id: agentId, name: "cli-session", session_id: sid }));
      if (bridge) {
        fs.writeFileSync(path.join(dir, "bridge.pid"), `${bridge}\n`);
      }
      return dir;
    }

    it("should stop the bridge, opt the session out and drop the enabled flag", async () => {
      // Arrange
      standIn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(standIn);
      const sid = "cli-sess-disable";
      const dir = enabledSession(sid, standIn.pid);

      // Act
      const r = await cli(["disable"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: sid }) });

      // Assert
      expect(r.code).toBe(0);
      expect(r.lines).toEqual(["agent-hub: disabled for this session."]);
      expect(fs.existsSync(path.join(dir, "enabled"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "opted-out"))).toBe(true);
      expect(fs.readFileSync(path.join(dir, "log"), "utf8")).toMatch(/disabled/);
    });

    it("should mark the agent offline itself when there was no bridge to stop", async () => {
      // Arrange
      const sid = "cli-sess-disable-nobridge";
      enabledSession(sid);

      // Act
      const r = await cli(["disable"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: sid }) });

      // Assert
      expect(r.code).toBe(0);
      await hub.waitFor((c) => c.path === `/api/agent/${agentId}/offline`);
      expect(r.errors).toEqual([]);
    });

    it("should warn rather than fail when it cannot mark the agent offline", async () => {
      // Arrange
      const sid = "cli-sess-disable-unreachable";
      enabledSession(sid);

      // Act
      const r = await cli(["disable"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: sid, AGENT_HUB_URL: "http://127.0.0.1:9" }) });

      // Assert
      expect(r.code).toBe(0);
      expect(r.errors.join("\n")).toMatch(/^warning: could not mark the agent offline: /);
    });

    it("should say the bridge stops on its next heartbeat when it does not exit in time", async () => {
      // Arrange: a bridge that ignores SIGTERM, as a busy one would while it finishes a delivery.
      const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "pipe", "ignore"]
      });
      children.push(stubborn);
      // Without waiting for the handler, the default disposition still applies and SIGTERM kills it.
      await new Promise<void>((resolve) => {
        stubborn.stdout?.once("data", () => resolve());
      });
      const sid = "cli-sess-disable-stubborn";
      enabledSession(sid, stubborn.pid);

      // Act
      const r = await cli(["disable"], { env: cliEnv({ CLAUDE_CODE_SESSION_ID: sid }) });

      // Assert
      expect(r.code).toBe(0);
      expect(r.lines).toEqual(["agent-hub: disabled for this session (bridge did not exit in time; it stops on its next heartbeat)."]);
      stubborn.kill("SIGKILL");
    });
  });

  describe("the hook command's output", () => {
    const hookEnv = () => cliEnv({ AGENT_HUB_URL: "http://127.0.0.1:9", AGENT_HUB_CLAUDE_PID: String(claudePid) });

    it("should exit 0 and print nothing for garbage or empty hook input", async () => {
      // Act and assert
      for (const input of ["", "not json", '{"session_id": "../../etc"}', '{"session_id": 5}']) {
        const r = await cli(["hook", "Stop"], { env: hookEnv(), input });
        expect(r.code).toBe(0);
        expect(r.raw()).toBe("");
      }
    });

    it("should print one line of context when SessionStart runs for an enabled session", async () => {
      // Act
      const r = await cli(["hook", "SessionStart"], { env: hookEnv(), input: JSON.stringify({ session_id: SID, source: "resume" }) });

      // Assert
      expect(r.code).toBe(0);
      expect(r.raw()).toMatch(/^agent-hub: comms are enabled for this session as @cli-session\./);
      expect(r.raw().trim().split("\n").length).toBe(1);
      expect(r.raw().endsWith("\n")).toBe(true);
    });

    it("should print the held notes once as UserPromptSubmit additionalContext JSON", async () => {
      // Arrange
      fs.writeFileSync(
        stateFile("held-notes.jsonl"),
        `${JSON.stringify({ at: "2026-10-09T00:00:00.000Z", text: "#50 touches the same table.", message_ids: ["50"] })}\n`
      );

      // Act
      const first = await cli(["hook", "UserPromptContext"], {
        env: hookEnv(),
        input: JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "hi" })
      });
      const second = await cli(["hook", "UserPromptContext"], { env: hookEnv(), input: JSON.stringify({ session_id: SID }) });

      // Assert
      expect(first.code).toBe(0);
      const out = JSON.parse(first.raw());
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(out.hookSpecificOutput.additionalContext).toMatch(/NOT from the user[\s\S]*#50 touches the same table\./);
      expect(fs.existsSync(stateFile("held-notes.jsonl"))).toBe(false);
      expect(second.raw()).toBe("");
    });

    /**
     * A `PreToolUse` whose stdin body is not JSON throws on the parse, before `runHook` — and so before
     * `parseQuestions` — can decide anything. Printing nothing then is read as "no decision" and
     * `AskUserQuestion`'s prompt is drawn, which in a pod nobody can answer. So the catch decides instead, from
     * the environment and the tool name alone.
     */
    it("should still deny a PreToolUse in a pod when the hook input is not JSON at all", async () => {
      // Act
      const r = await cli(["hook", "PreToolUse"], {
        env: cliEnv({
          AGENT_HUB_URL: "http://127.0.0.1:9",
          AGENT_HUB_VIRTUAL_AGENT_ID: "0f8a6a1e-1234-4000-8000-000000000001",
          AGENT_HUB_LAUNCH_TOKEN: "lt-abc123"
        }),
        input: "not json"
      });

      // Assert
      expect(r.code).toBe(0);
      expect(JSON.parse(r.raw())).toEqual(denyOutput(UNDELIVERED_REASON));
    });

    it("should decide nothing for an unreadable PreToolUse in an engineer's own session, who can answer the prompt", async () => {
      // Act
      const r = await cli(["hook", "PreToolUse"], { env: hookEnv(), input: "not json" });

      // Assert
      expect(r.code).toBe(0);
      expect(r.raw()).toBe("");
    });

    it("should log the failure against the session and still exit 0 when a hook throws", async () => {
      // Arrange: an unreadable state dir makes the Stop hook's write fail.
      const sid = "cli-sess-hookfail";
      const dir = path.join(home.hub, sid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "enabled"), "x");
      fs.mkdirSync(path.join(dir, "status"));

      // Act
      const r = await cli(["hook", "Stop"], { env: hookEnv(), input: JSON.stringify({ session_id: sid }) });

      // Assert
      expect(r.code).toBe(0);
      expect(r.raw()).toBe("");
      expect(fs.readFileSync(path.join(dir, "log"), "utf8")).toMatch(/hook Stop failed: /);
    });
  });

  describe("the transcript command", () => {
    it("should turn the upload off, on again and report where it is", async () => {
      // Arrange
      const transcript = path.join(home.root, "cli-transcript.jsonl");
      fs.writeFileSync(transcript, '{"type":"user","uuid":"a","message":{"role":"user","content":"hi"}}\n');
      fs.writeFileSync(stateFile("transcript"), `${transcript}\n`);

      // Act and assert
      const off = await cli(["transcript", "off"]);
      expect(off.code).toBe(0);
      expect(off.lines).toEqual(["agent-hub: this session's transcript is no longer uploaded. What was already uploaded stays on agent-hub."]);
      expect(fs.existsSync(stateFile("transcript-off"))).toBe(true);
      expect((await cli(["transcript", "status"])).text()).toMatch(/transcript: off for this session \(agent-hub transcript on to resume\)/);

      const on = await cli(["transcript", "on"]);
      expect(on.lines[0]).toBe("agent-hub: this session's transcript is uploaded again while comms are enabled, from now on (not the turns while it was off).");
      expect(fs.existsSync(stateFile("transcript-off"))).toBe(false);
      const onStatus = await cli(["transcript", "status"]);
      expect(onStatus.text()).toMatch(/transcript: uploaded while comms are enabled/);
      expect(onStatus.text()).toMatch(/comms: {6}enabled/);
      expect(onStatus.text()).toMatch(new RegExp(`file: {7}${transcript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      expect(onStatus.text()).toMatch(new RegExp(`uploaded: {3}to byte \\d+ of ${fs.statSync(transcript).size}`));

      const byEnv = await cli(["transcript", "status"], { env: cliEnv({ AGENT_HUB_TRANSCRIPT: "off" }) });
      expect(byEnv.text()).toMatch(/transcript: off \(AGENT_HUB_TRANSCRIPT=off\)/);
      const onWithEnv = await cli(["transcript", "on"], { env: cliEnv({ AGENT_HUB_TRANSCRIPT: "off" }) });
      expect(onWithEnv.lines.at(-1)).toBe("note: AGENT_HUB_TRANSCRIPT=off is set in the environment, which still stops it.");

      const sideways = await cli(["transcript", "sideways"]);
      expect(sideways.code).toBe(2);
      expect(sideways.errors.join("\n")).toMatch(/transcript takes off, on or status/);
    });
  });

  describe("the credentials command", () => {
    const VID = "va-cred";
    const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
    // Built at runtime so no secret-shaped literal sits in the repo.
    const LAUNCH = `launch-${"c".repeat(16)}`;
    const AZ_TOKEN = `az-${"t".repeat(30)}`;
    const GIT_IDENTITY = '{"name":"Olive Owner","email":"olive@example.com"}';
    const GH_TOKEN = `${"gh"}o_${"K4l5M6n7".repeat(4)}`;
    const JENKINS_TOKEN = `11${"a0b1c2d3".repeat(4)}`;
    const CLAUDE_MD = "  # Olive\n\nI work on PCS.\n\n\tIndented, trailing spaces  \n\n";
    const DEFAULT_CLAUDE_MD = "You are running in a pod in Preview and connected via the agent hub.";

    let credHub: MockHub;
    let credUrl: string;
    let bin: string;
    let savedPath: string | undefined;

    const shim = (name: string, body: string) => {
      fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    };
    const baseEnv = (extra: Env = {}): Env => ({ HOME: home.root, CLAUDE_CONFIG_DIR: home.claude, AGENT_HUB_URL: credUrl, ...extra });
    const personEnv = (extra: Env = {}) => baseEnv({ AGENT_HUB_DEV_USER: DEV_USER, ...extra });
    const podEnv = (extra: Env = {}) => baseEnv({ AGENT_HUB_VIRTUAL_AGENT_ID: VID, AGENT_HUB_LAUNCH_TOKEN: LAUNCH, ...extra });
    const mine = () => credHub.personCredentials.get("u-me") ?? new Map<string, string>();
    const virtual = () => credHub.virtuals.get(VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;

    function assertNoSecrets(...results: Invocation[]) {
      for (const r of results) {
        for (const secret of [GH_TOKEN, JENKINS_TOKEN, LAUNCH, AZ_TOKEN]) {
          expect(r.errors.join("\n"), "the error output must never carry a secret").not.toContain(secret);
        }
      }
    }

    beforeAll(async () => {
      bin = path.join(home.root, "cred-bin");
      fs.mkdirSync(bin, { recursive: true });
      shim("gh", `[ "$1 $2" = "auth token" ] && printf '%s\\n' "${GH_TOKEN}" && exit 0; exit 2`);
      shim(
        "az",
        `printf '%s\\n' "$*" >> "${path.join(home.root, "az-calls")}"
[ "$1 $2" = "account get-access-token" ] || exit 2
printf '{"accessToken": "%s", "expires_on": "%s"}\\n' "${AZ_TOKEN}" "$(( $(date +%s) + 3600 ))"`
      );
      savedPath = process.env.PATH;
      process.env.PATH = `${bin}:${savedPath}`;
      credHub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
      credUrl = await credHub.listen();
    });

    afterAll(async () => {
      if (savedPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = savedPath;
      }
      await credHub.close();
    });

    it("should exit 4 with no output, store from stdin, print only the value and forget it on delete, as a person", async () => {
      // Arrange
      const env = personEnv();

      // Act and assert
      const missing = await cli(["credentials", "get", "git_identity"], { env });
      expect(missing.code).toBe(4);
      expect(missing.raw()).toBe("");
      expect(missing.errors).toEqual([]);

      const set = await cli(["credentials", "set", "git_identity"], { env, input: `${GIT_IDENTITY}\n` });
      expect(set.code).toBe(0);
      expect(set.raw()).toBe("");
      expect(mine().get("git_identity")).toBe(GIT_IDENTITY);
      expect(credHub.calls.findLast((c) => c.method === "PUT")?.path).toBe("/api/agent/credentials/git_identity");

      const got = await cli(["credentials", "get", "git_identity"], { env });
      expect(got.code).toBe(0);
      expect(got.raw()).toBe(GIT_IDENTITY);
      expect(got.errors).toEqual([]);

      const del = await cli(["credentials", "delete", "git_identity"], { env });
      expect(del.code).toBe(0);
      expect(mine().has("git_identity")).toBe(false);
      expect((await cli(["credentials", "get", "git_identity"], { env })).code).toBe(4);

      const again = await cli(["credentials", "delete", "git_identity"], { env });
      expect(again.code).toBe(0);
      expect(again.errors.join("\n")).toMatch(/no git_identity credential was stored/);
      assertNoSecrets(missing, set, got, del, again);
    });

    it("should read back only claude_md and git_identity, and store the gh token as github with --from-gh", async () => {
      // Arrange
      const env = personEnv();

      // Act
      const github = await cli(["credentials", "get", "github"], { env });
      const fromGh = await cli(["credentials", "set", "github", "--from-gh"], { env });
      const ghWrongKind = await cli(["credentials", "set", "jenkins", "--from-gh"], { env });
      const empty = await cli(["credentials", "set", "jenkins"], { env, input: "  \n" });
      const noSuchKind = await cli(["credentials", "get", "nope"], { env });
      const noSuchAction = await cli(["credentials", "list"], { env });
      const extra = await cli(["credentials", "get", "git_identity", "stray"], { env });

      // Assert
      expect(github.code).toBe(2);
      expect(github.raw()).toBe("");
      expect(github.errors.join("\n")).toMatch(
        /agent-hub returns only your claude_md and git_identity credentials; the other kinds are read by virtual agents/
      );
      expect(fromGh.code).toBe(0);
      expect(mine().get("github")).toBe(GH_TOKEN);
      expect(ghWrongKind.code).toBe(2);
      expect(ghWrongKind.errors.join("\n")).toMatch(/--from-gh only goes with credentials set github/);
      expect(empty.code).toBe(2);
      expect(empty.errors.join("\n")).toMatch(/credentials set reads the jenkins value from stdin, and it was empty/);
      expect(noSuchKind.code).toBe(2);
      expect(noSuchKind.errors.join("\n")).toMatch(/credential kind must be one of github, azure, claude, jenkins, atlassian, claude_md, git_identity/);
      expect(noSuchAction.code).toBe(2);
      expect(noSuchAction.errors.join("\n")).toMatch(/credentials takes get, set or delete/);
      expect(extra.code).toBe(2);
      expect(extra.errors.join("\n")).toMatch(/unexpected argument: stray/);
      assertNoSecrets(github, fromGh);
      credHub.personCredentials.clear();
    });

    it("should use the Entra token az issues for the agent-hub scope as the bearer when there is no dev user", async () => {
      // Arrange
      fs.rmSync(path.join(home.root, "az-calls"), { force: true });

      // Act
      const r = await cli(["credentials", "get", "claude_md"], { env: baseEnv() });

      // Assert
      const call = credHub.calls.findLast((c) => c.path === "/api/agent/credentials/claude_md");
      expect(call?.headers.authorization).toBe(`Bearer ${AZ_TOKEN}`);
      expect(fs.readFileSync(path.join(home.root, "az-calls"), "utf8")).toMatch(/--scope api:\/\/dtsse-agent-hub\/\.default/);
      // The mock knows no such token, so this is the hub refusing: a failure, not "not stored".
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/401/);
      assertNoSecrets(r);
    });

    it("should exit 1, not the not-stored exit 4, when the hub is unreachable", async () => {
      // Act
      const r = await cli(["credentials", "get", "claude_md"], { env: personEnv({ AGENT_HUB_URL: "http://127.0.0.1:9" }) });

      // Assert
      expect(r.code).toBe(1);
      expect(r.raw()).toBe("");
    });

    it("should read and store its own agent's credential through the virtual routes with a pod's launch token", async () => {
      // Arrange
      const env = podEnv();

      // Act
      const missing = await cli(["credentials", "get", "jenkins"], { env });
      const getPath = credHub.calls.findLast((c) => c.method === "GET")?.path;
      virtual().credentials.set("jenkins", JENKINS_TOKEN);
      const got = await cli(["credentials", "get", "jenkins"], { env });
      const set = await cli(["credentials", "set", "github"], { env, input: GH_TOKEN });
      const del = await cli(["credentials", "delete", "jenkins"], { env });

      // Assert
      expect(missing.code).toBe(4);
      expect(missing.raw()).toBe("");
      expect(getPath).toBe(`/api/virtual/${VID}/credentials/jenkins`);
      expect(got.code).toBe(0);
      expect(got.raw()).toBe(JENKINS_TOKEN);
      expect(set.code).toBe(0);
      expect(virtual().credentials.get("github")).toBe(GH_TOKEN);
      expect(credHub.personCredentials.size).toBe(0);
      expect(del.code).toBe(2);
      expect(del.errors.join("\n")).toMatch(/a virtual agent cannot delete its credentials; its owner removes them in the CFT Workspace's settings/);
      expect(virtual().credentials.get("jenkins")).toBe(JENKINS_TOKEN);
      assertNoSecrets(missing, got, set, del);
      virtual().credentials.clear();
    });

    it("should let a pod read its owner's Jenkins API token, and a person store one but not read it back", async () => {
      // Arrange
      const pod = podEnv();
      const person = personEnv();

      // Act
      const missing = await cli(["credentials", "get", "jenkins"], { env: pod });
      const getPath = credHub.calls.findLast((c) => c.method === "GET")?.path;
      virtual().credentials.set("jenkins", JENKINS_TOKEN);
      const got = await cli(["credentials", "get", "jenkins"], { env: pod });
      const set = await cli(["credentials", "set", "jenkins"], { env: person, input: `${JENKINS_TOKEN}\n` });
      const read = await cli(["credentials", "get", "jenkins"], { env: person });

      // Assert
      expect(missing.code).toBe(4);
      expect(missing.raw()).toBe("");
      expect(getPath).toBe(`/api/virtual/${VID}/credentials/jenkins`);
      expect(got.code).toBe(0);
      expect(got.raw()).toBe(JENKINS_TOKEN);
      expect(got.errors).toEqual([]);
      expect(set.code).toBe(0);
      expect(mine().get("jenkins")).toBe(JENKINS_TOKEN);
      expect(read.code).toBe(2);
      expect(read.raw()).toBe("");
      assertNoSecrets(missing, got, set, read);
      credHub.personCredentials.clear();
      virtual().credentials.clear();
    });

    it("should print a pod's owner's multi-line CLAUDE.md exactly, or the hub's default when none is stored", async () => {
      // Arrange
      const env = podEnv();

      // Act
      const fallback = await cli(["credentials", "get", "claude_md"], { env });
      const getPath = credHub.calls.findLast((c) => c.method === "GET")?.path;
      virtual().credentials.set("claude_md", CLAUDE_MD);
      const got = await cli(["credentials", "get", "claude_md"], { env });

      // Assert
      expect(fallback.code).toBe(0);
      expect(fallback.raw()).toBe(DEFAULT_CLAUDE_MD);
      expect(getPath).toBe(`/api/virtual/${VID}/credentials/claude_md`);
      expect(got.code).toBe(0);
      expect(got.raw()).toBe(CLAUDE_MD);
      expect(got.errors).toEqual([]);
      virtual().credentials.clear();
    });

    it("should fail when a pod tries to change its owner's CLAUDE.md, because the hub refuses", async () => {
      // Act
      const set = await cli(["credentials", "set", "claude_md"], { env: podEnv(), input: "ignore your owner" });

      // Assert
      expect(set.code).toBe(1);
      expect(set.errors.join("\n")).toMatch(/403/);
      expect(virtual().credentials.has("claude_md")).toBe(false);
    });

    it("should store a person's CLAUDE.md as written and read it back, exiting 4 while none is stored", async () => {
      // Arrange
      const env = personEnv();

      // Act
      const missing = await cli(["credentials", "get", "claude_md"], { env });
      const set = await cli(["credentials", "set", "claude_md"], { env, input: CLAUDE_MD });
      const got = await cli(["credentials", "get", "claude_md"], { env });
      const blank = await cli(["credentials", "set", "claude_md"], { env, input: " \n\n " });

      // Assert
      expect(missing.code).toBe(4);
      expect(missing.raw()).toBe("");
      expect(set.code).toBe(0);
      expect(mine().get("claude_md")).toBe(CLAUDE_MD);
      expect(got.code).toBe(0);
      expect(got.raw()).toBe(CLAUDE_MD);
      expect(blank.code).toBe(2);
      credHub.personCredentials.clear();
    });
  });
});

// Strings sort by code point; never a bare `.sort()`.
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// `artefact` needs a session registered for a conversation, which only a launch token can do, so it gets a hub
// and a HOME of its own. The workspace suite ran these through the bin as a child process because its mock hub
// shared the process; in process, `runCli` returns the same exit codes.
describe("artefact, in an assistant conversation", () => {
  const VID = "va-assist";
  const LAUNCH = `launch-${"d".repeat(16)}`;
  const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };

  let home: TempClaudeHome;
  let hub: MockHub;
  let url: string;
  let nextSession = 0;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    home = tempClaudeHome();
    for (const key of ["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR", "AGENT_HUB_URL", "AGENT_HUB_DEV_USER", "AGENT_HUB_LAUNCH_TOKEN"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(process.env, home.env, { CLAUDE_PROJECT_DIR: home.root });
    hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
    url = await hub.listen();
  });

  afterAll(async () => {
    await hub.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    home.cleanup();
  });

  // A session with comms enabled, registered for a conversation unless `conversation` is false.
  async function session({ conversation = true }: { conversation?: boolean } = {}): Promise<{ sid: string; agentId: string }> {
    const sid = `artefact-sess-${++nextSession}`;
    const body: RegisterBody = { session_id: sid, name: sid, name_source: "derived", client_features: [...CLIENT_FEATURES] };
    if (conversation) {
      body.conversation_id = `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`;
    }
    const { agent_id: agentId } = await createApi({ baseUrl: url, launchToken: LAUNCH }).register(body);
    const dir = path.join(home.hub, sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enabled"), "x");
    // As `registerAgent` saves a conversation's session, with the conversation it is.
    fs.writeFileSync(path.join(dir, "agent.json"), JSON.stringify({ agent_id: agentId, session_id: sid, name: sid, conversation_id: body.conversation_id }));
    return { sid, agentId };
  }

  async function cli(args: string[], { sid, input = "", extraEnv = {} }: { sid: string; input?: string; extraEnv?: Env }): Promise<Invocation> {
    const out = sink();
    // The single predicate wants the agent id as well as the token, where the workspace's `hasLaunchToken` took the token alone.
    const env: Env = {
      ...process.env,
      AGENT_HUB_URL: url,
      AGENT_HUB_VIRTUAL_AGENT_ID: VID,
      AGENT_HUB_LAUNCH_TOKEN: LAUNCH,
      CLAUDE_CODE_SESSION_ID: sid,
      ...extraEnv
    };
    const code = await runCli(args, { ...out.options, env, readStdin: () => input, cwd: () => home.root });
    return { ...out, code };
  }

  const puts = (agentId: string) => hub.calls.filter((c) => c.method === "PUT" && c.path === `/api/agent/${agentId}/artefact`);

  it("should print the markdown, or the whole document with --json, when artefact get runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act
    const empty = await cli(["artefact", "get"], { sid });

    // Assert
    expect(empty.code).toBe(0);
    expect(empty.raw()).toBe("");
    expect(empty.errors.join("\n")).toMatch(/document is empty \(version 0\)/);

    // Act
    hub.editArtefactAsUser(agentId, "# Stories\n\nAs a claimant…", "Fee stories");
    const got = await cli(["artefact", "get"], { sid });
    const json = await cli(["artefact", "get", "--json"], { sid });

    // Assert
    expect(got.code).toBe(0);
    expect(got.raw()).toBe("# Stories\n\nAs a claimant…\n");
    expect(json.code).toBe(0);
    const { title, markdown, version, updated_by } = JSON.parse(json.lines[0] as string);
    expect({ title, markdown, version, updated_by }).toEqual({ title: "Fee stories", markdown: "# Stories\n\nAs a claimant…", version: 1, updated_by: "user" });
  });

  it("should read the current version first and save stdin with the title when artefact put has no --base", async () => {
    // Arrange
    const { sid, agentId } = await session();
    hub.editArtefactAsUser(agentId, "first draft");

    // Act
    const r = await cli(["artefact", "put", "--title", "Research plan"], { sid, input: "# Research plan\n\n1. Recruit\n" });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/saved the conversation's document as version 2/);
    expect(puts(agentId)[0]?.body).toEqual({ markdown: "# Research plan\n\n1. Recruit\n", base_version: 1, title: "Research plan" });
    expect(hub.artefacts.get(agentId)?.updated_by).toBe("agent");
  });

  it("should refuse to save, naming the current version, when the document changed since --base", async () => {
    // Arrange
    const { sid, agentId } = await session();
    hub.editArtefactAsUser(agentId, "one");
    hub.editArtefactAsUser(agentId, "two");

    // Act
    const r = await cli(["artefact", "put", "--base", "1"], { sid, input: "my change" });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/changed since version 1: it is now version 2, last written by the user\. Nothing was saved\./);
    expect(r.errors.join("\n")).toMatch(/artefact get, merge your change into it, and put it again with --base 2/);
    expect(hub.artefacts.get(agentId)?.markdown).toBe("two");
  });

  it("should refuse an empty document and a secret-shaped one when artefact put reads stdin", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act
    const empty = await cli(["artefact", "put"], { sid, input: "  \n" });
    const secret = await cli(["artefact", "put"], { sid, input: `token ${fakeSecrets.githubToken}` });

    // Assert
    expect(empty.code).toBe(2);
    expect(empty.errors.join("\n")).toMatch(/reads the markdown from stdin, and it was empty/);
    expect(secret.code).toBe(1);
    expect(secret.errors.join("\n")).toMatch(/secret-shaped string/);
    expect(puts(agentId)).toHaveLength(0);
  });

  it("should say the session has no document when artefact get runs outside a conversation", async () => {
    // Arrange
    const { sid } = await session({ conversation: false });

    // Act
    const r = await cli(["artefact", "get"], { sid });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/not a CFT Workspace conversation/);
  });

  it("should refuse the arguments the other action takes, and a --base that is not a version", async () => {
    // Arrange
    const { sid } = await session();

    // Act & Assert
    for (const args of [
      ["artefact"],
      ["artefact", "edit"],
      ["artefact", "get", "extra"],
      ["artefact", "get", "--title", "T"],
      ["artefact", "get", "--base", "1"],
      ["artefact", "put", "--json"],
      ["artefact", "put", "--base", "latest"]
    ]) {
      expect((await cli(args, { sid, input: "x" })).code, args.join(" ")).toBe(2);
    }
  });

  describe("deck", () => {
    // Magic bytes are all the mock looks at; the hub reads the rest.
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 5, 6]);
    const PPTX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 9, 9]);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

    function outline(image: Record<string, unknown>) {
      return {
        title: "Ways of working",
        slides: [
          { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
          { layout: "HMCTS_IMAGE", title: "Our pipeline", image: { ...image, alt: "The pipeline" } },
          { layout: "HMCTS_IMAGE", title: "The pipeline again", image: { ...image, alt: "The pipeline once more" } }
        ]
      };
    }

    function workDir(): string {
      const dir = fs.mkdtempSync(path.join(home.root, "deck-"));
      fs.writeFileSync(path.join(dir, "pipeline.png"), PNG);
      fs.writeFileSync(path.join(dir, "deck.pptx"), PPTX);
      fs.writeFileSync(path.join(dir, "outline.json"), JSON.stringify(outline({ path: "pipeline.png" })));
      return dir;
    }

    const calls = (agentId: string, method: string, tail: string) =>
      hub.calls.filter((c) => c.method === method && c.path.startsWith(`/api/agent/${agentId}/deck${tail}`));

    it("should say there is no deck yet, and exit 0, when deck get runs before one is written", async () => {
      // Arrange
      const { sid } = await session();

      // Act
      const r = await cli(["deck", "get"], { sid });

      // Assert
      expect(r.code).toBe(0);
      expect(r.errors.join("\n")).toMatch(/no slide deck yet \(version 0\)/);
    });

    it("should upload each picture once, publish the outline naming them by digest and then the .pptx, when deck put runs", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const dir = workDir();

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--pptx", path.join(dir, "deck.pptx"), "--summary", "First draft"], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      expect(r.text()).toMatch(/published the slide deck as version 1, with its \.pptx/);
      expect(calls(agentId, "PUT", "/assets/")).toHaveLength(1);
      const put = calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`);
      expect(put?.body).toEqual({ outline: outline({ asset: `sha256:${digest(PNG)}` }), base_version: 0, summary: "First draft" });
      expect(hub.decks.get(agentId)?.pptx.get(1)).toEqual(PPTX);
      // The ids the hub gave are kept in the file, so the next put sends them back.
      const kept = JSON.parse(fs.readFileSync(path.join(dir, "outline.json"), "utf8"));
      expect(kept.slides.map((slide: { id?: string }) => slide.id)).toEqual(["why", "s_0001", "s_0002"]);
      expect(kept.slides[1].image).toEqual({ path: "pipeline.png", alt: "The pipeline" });
    });

    it("should write the outline with its pictures downloaded beside it and named by path, when deck get runs", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(GIF)}` }), { [digest(GIF)]: GIF });

      // Act
      const r = await cli(["deck", "get"], { sid });
      const again = await cli(["deck", "get", "--json"], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      const written = JSON.parse(fs.readFileSync(path.join(dir, "outline.json"), "utf8"));
      const file = `assets/${digest(GIF)}.gif`;
      expect(written.slides[1].image).toEqual({ path: file, alt: "The pipeline" });
      expect(written.slides[2].image.path).toBe(file);
      expect(fs.readFileSync(path.join(dir, file))).toEqual(GIF);
      expect(r.text()).toMatch(/deck put \S*outline\.json --pptx <deck\.pptx>, which puts it as a change to version 1/);
      expect(fs.readFileSync(path.join(dir, "version"), "utf8")).toBe("1\n");
      // The picture was already there with the right digest, so the second read fetched nothing.
      expect(calls(agentId, "GET", "/assets/")).toHaveLength(1);
      expect(JSON.parse(again.lines[0] as string)).toMatchObject({ title: "Ways of working", version: 1, updated_by: "user", pptx: false });
    });

    it("should print one slide by its id, and refuse an id the deck does not have, when deck get has --slide", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });

      // Act
      const one = await cli(["deck", "get", "--slide", "why"], { sid });
      const none = await cli(["deck", "get", "--slide", "s_ffff"], { sid });

      // Assert
      expect(one.code).toBe(0);
      expect(JSON.parse(one.lines[0] as string)).toMatchObject({ version: 1, number: 2, slide: { id: "why", title: "Why it matters" } });
      expect(none.code).toBe(1);
      expect(none.errors.join("\n")).toMatch(/version 1 has no slide with id s_ffff/);
    });

    it("should write an older version beside the working copy, saying the version to put a change on, when deck get has --version", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const older = outline({ asset: `sha256:${digest(PNG)}` });
      hub.writeDeckAsUser(agentId, older, { [digest(PNG)]: PNG });
      hub.writeDeckAsUser(agentId, { ...older, title: "Ways of shipping" });

      // Act
      const r = await cli(["deck", "get", "--version", "1"], { sid });
      const json = await cli(["deck", "get", "--version", "1", "--json"], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      expect(JSON.parse(fs.readFileSync(path.join(dir, "outline-v1.json"), "utf8")).title).toBe("Ways of working");
      expect(fs.existsSync(path.join(dir, "outline.json"))).toBe(false);
      expect(fs.existsSync(path.join(dir, "version"))).toBe(false);
      expect(r.text()).toMatch(/wrote version 1 of the slide deck, which is not the latest \(version 2\)/);
      expect(r.text()).toMatch(/deck put .*outline-v1\.json --pptx <deck\.pptx> --base 2/);
      expect(calls(agentId, "GET", "").some((c) => c.query?.version === "1")).toBe(true);
      expect(JSON.parse(json.lines[0] as string)).toMatchObject({ version: 1, latest_version: 2, outline: path.join(dir, "outline-v1.json") });
    });

    it("should say the version is not kept, and refuse a version that is not a number, when deck get has --version", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });

      // Act
      const missing = await cli(["deck", "get", "--version", "9"], { sid });
      const bad = await cli(["deck", "get", "--version", "v2"], { sid });

      // Assert
      expect(missing.code).toBe(1);
      expect(missing.errors.join("\n")).toMatch(/does not keep version 9/);
      expect(bad.code).not.toBe(0);
      expect(bad.errors.join("\n")).toMatch(/--version takes a version number from 1/);
    });

    it("should put against the version deck get read, and refuse the put, when someone writes a newer one in between", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      expect((await cli(["deck", "get"], { sid })).code).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }));

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/changed since version 1: it is now version 2, last written by the user\. Nothing was saved\./);
      expect(calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`)?.body).toMatchObject({ base_version: 1 });
      expect(hub.decks.get(agentId)?.version).toBe(2);
    });

    it("should refuse the put, saying the user changed it, when the user amended the version deck get read", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      expect((await cli(["deck", "get"], { sid })).code).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      hub.amendDeckAsUser(agentId, { ...outline({ asset: `sha256:${digest(PNG)}` }), title: "Ways of shipping" });

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });

      // Assert
      expect(fs.readFileSync(path.join(dir, "revision"), "utf8")).toBe("1\n");
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/the user has changed version 1 of the deck since you read it\. Nothing was saved\./);
      expect(calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`)?.body).toMatchObject({ base_version: 1, base_revision: 1 });
      expect(hub.decks.get(agentId)?.outline?.title).toBe("Ways of shipping");
    });

    it("should refuse a put with --base when the user amended the version deck get read", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      expect((await cli(["deck", "get"], { sid })).code).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      hub.amendDeckAsUser(agentId, { ...outline({ asset: `sha256:${digest(PNG)}` }), title: "Ways of shipping" });

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--base", "1"], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/the user has changed version 1 of the deck since you read it\. Nothing was saved\./);
      expect(r.errors.join("\n")).toMatch(/Run agent-hub deck get, make your change to the outline it writes, build it, and put again\./);
      expect(calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`)?.body).toMatchObject({ base_version: 1, base_revision: 1 });
      expect(hub.decks.get(agentId)?.outline?.title).toBe("Ways of shipping");
    });

    it("should put an older version back with --base naming the latest, sending no revision, when deck get --version wrote it", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const first = outline({ asset: `sha256:${digest(PNG)}` });
      hub.writeDeckAsUser(agentId, first, { [digest(PNG)]: PNG });
      for (let version = 2; version <= 7; version += 1) {
        hub.writeDeckAsUser(agentId, { ...first, title: `Version ${version}` });
      }
      hub.amendDeckAsUser(agentId, { ...first, title: "Version 7, amended" });
      expect((await cli(["deck", "get"], { sid })).code).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      expect(fs.readFileSync(path.join(dir, "version"), "utf8")).toBe("7\n");
      expect(fs.readFileSync(path.join(dir, "revision"), "utf8")).toBe("8\n");
      hub.writeDeckAsUser(agentId, { ...first, title: "Version 8" });
      hub.writeDeckAsUser(agentId, { ...first, title: "Version 9" });
      const older = await cli(["deck", "get", "--version", "3"], { sid });
      expect(older.text()).toMatch(/deck put .*outline-v3\.json --pptx <deck\.pptx> --base 9/);

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline-v3.json"), "--base", "9"], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      const body = calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`)?.body as Record<string, unknown>;
      expect(body).toMatchObject({ base_version: 9 });
      expect(body).not.toHaveProperty("base_revision");
      expect(hub.decks.get(agentId)).toMatchObject({ version: 10, outline: { title: "Version 3" } });
    });

    it("should say the deck moved on, not that the user changed the version, when an explicit --base is behind", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }));
      expect((await cli(["deck", "get"], { sid })).code).toBe(0);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--base", "1"], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/changed since version 1: it is now version 2, last written by the user\. Nothing was saved\./);
      expect(r.errors.join("\n")).not.toMatch(/the user has changed version/);
      expect(calls(agentId, "PUT", "").find((c) => c.path === `/api/agent/${agentId}/deck`)?.body).not.toHaveProperty("base_revision");
    });

    it("should record the revision each put answers, and send it with --base too", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      await cli(["deck", "get"], { sid });
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);

      // Act
      const put = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });
      const explicit = await cli(["deck", "put", path.join(dir, "outline.json"), "--base", "2"], { sid });

      // Assert
      expect(put.code, put.errors.join("\n")).toBe(0);
      expect(explicit.code, explicit.errors.join("\n")).toBe(0);
      expect(fs.readFileSync(path.join(dir, "revision"), "utf8")).toBe("3\n");
      const bodies = calls(agentId, "PUT", "")
        .filter((c) => c.path === `/api/agent/${agentId}/deck`)
        .map((c) => c.body);
      expect(bodies[0]).toMatchObject({ base_version: 1, base_revision: 1 });
      expect(bodies[1]).toMatchObject({ base_version: 2, base_revision: 2 });
    });

    it("should write the latest version and print what changed since the version asked for, slide by slide, when deck get has --diff-from", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const first = {
        title: "Ways of working",
        slides: [
          { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
          { id: "how", layout: "HMCTS_CONTENT", title: "How we ship", bullets: ["Build", "Test"] },
          { id: "old", layout: "HMCTS_SECTION", title: "Going away" }
        ]
      };
      hub.writeDeckAsUser(agentId, first);
      hub.writeDeckAsUser(agentId, {
        title: "Ways of working",
        slides: [
          { id: "how", layout: "HMCTS_CONTENT", title: "How we ship", bullets: ["Build", "Test", "Release"] },
          { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
          { id: "new", layout: "HMCTS_SECTION", title: "Questions" }
        ]
      });

      // Act
      const r = await cli(["deck", "get", "--diff-from", "1"], { sid });
      const json = await cli(["deck", "get", "--diff-from", "1", "--json"], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      expect(r.text().trimEnd().split("\n")).toEqual([
        "Version 2, the latest, against version 1: 1 slide changed, 1 slide added, 1 slide removed and 1 slide moved.",
        'Slide 2, id how, changed: "How we ship"',
        "  Bullets: Build",
        "    Test",
        "    {+Release+}",
        // A removed slide is listed after the one it followed in the older version.
        'Removed: slide 4 of version 1, id old: "Going away"',
        'Slide 3, id why, moved from slide 2: "Why it matters"',
        'Slide 4, id new, added: "Questions"',
        expect.stringMatching(/^agent-hub: wrote version 2 of the slide deck to \S*outline\.json/)
      ]);
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);
      expect(fs.readFileSync(path.join(dir, "version"), "utf8")).toBe("2\n");
      expect(JSON.parse(json.lines[0] as string)).toMatchObject({
        version: 2,
        revision: 2,
        diff_from: 1,
        diff: { counts: { added: 1, removed: 1, moved: 1, changed: 1 } }
      });
    });

    it("should refuse --diff-from with --version or --slide, one that is not a number, and a version the deck does not keep", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });

      // Act
      const withVersion = await cli(["deck", "get", "--diff-from", "1", "--version", "1"], { sid });
      const withSlide = await cli(["deck", "get", "--diff-from", "1", "--slide", "why"], { sid });
      const bad = await cli(["deck", "get", "--diff-from", "v1"], { sid });
      const missing = await cli(["deck", "get", "--diff-from", "9"], { sid });

      // Assert
      expect(withVersion.errors.join("\n")).toMatch(/cannot be given with --version or --slide/);
      expect(withSlide.errors.join("\n")).toMatch(/cannot be given with --version or --slide/);
      expect(bad.errors.join("\n")).toMatch(/--diff-from takes a version number from 1/);
      expect(missing.code).toBe(1);
      expect(missing.errors.join("\n")).toMatch(/does not keep version 9; the hub keeps the latest 100\. The latest, version 1, is in /);
    });

    it("should record each version it puts from deck get's directory, so the next put builds on it", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      await cli(["deck", "get"], { sid });
      const dir = path.join(home.root, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`);

      // Act
      const first = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });
      const second = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });
      const explicit = await cli(["deck", "put", path.join(dir, "outline.json"), "--base", "1"], { sid });

      // Assert
      expect(first.code, first.errors.join("\n")).toBe(0);
      expect(second.code, second.errors.join("\n")).toBe(0);
      expect(fs.readFileSync(path.join(dir, "version"), "utf8")).toBe("3\n");
      expect(explicit.code).toBe(1);
      expect(explicit.errors.join("\n")).toMatch(/changed since version 1: it is now version 3/);
    });

    it("should quote the outline's path in the deck put it prints, when the home directory has a space in it", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      const spaced = fs.mkdtempSync(path.join(home.root, "my home "));

      // Act
      const r = await cli(["deck", "get"], { sid, extraEnv: { HOME: spaced } });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      const file = path.join(spaced, ".agent-hub", "decks", `0f8a6a1e-0000-4000-8000-${String(nextSession).padStart(12, "0")}`, "outline.json");
      expect(r.text()).toContain(`deck put '${file}' --pptx <deck.pptx>`);
    });

    it("should refuse to publish, naming the current version, when the deck changed since --base", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }));
      const dir = workDir();

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--pptx", path.join(dir, "deck.pptx"), "--base", "1"], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/changed since version 1: it is now version 2, last written by the user\. Nothing was saved\./);
      expect(r.errors.join("\n")).toMatch(/Run agent-hub deck get, make your change to the outline it writes, build it, and put again\./);
      expect(r.errors.join("\n")).not.toMatch(/--base/);
      expect(calls(agentId, "PUT", "/versions/")).toHaveLength(0);
    });

    it("should publish an outline whose pictures are already named by digest, saying it is not built, when there is no --pptx", async () => {
      // Arrange
      const { sid, agentId } = await session();
      hub.writeDeckAsUser(agentId, { title: "Empty" }, { [digest(PNG)]: PNG });
      const dir = fs.mkdtempSync(path.join(home.root, "deck-"));
      fs.writeFileSync(path.join(dir, "outline.json"), JSON.stringify(outline({ asset: `sha256:${digest(PNG)}` })));

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json")], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      expect(r.text()).toMatch(/as version 2; the person sees it as not built/);
      expect(calls(agentId, "PUT", "/assets/")).toHaveLength(0);
    });

    it("should send the .pptx again when the hub fails it once, when deck put runs", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const dir = workDir();
      hub.failNextDeckPptx(1);

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--pptx", path.join(dir, "deck.pptx")], { sid });

      // Assert
      expect(r.code, r.errors.join("\n")).toBe(0);
      expect(calls(agentId, "PUT", "/versions/1/pptx")).toHaveLength(2);
      expect(hub.decks.get(agentId)?.pptx.get(1)).toEqual(PPTX);
    });

    it("should exit 1 naming the version published without its .pptx, and the command that sends it alone, when every try fails", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const dir = workDir();
      hub.failNextDeckPptx(3, 503);

      // Act
      const r = await cli(["deck", "put", path.join(dir, "outline.json"), "--pptx", path.join(dir, "deck.pptx")], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(calls(agentId, "PUT", "/versions/1/pptx")).toHaveLength(3);
      const said = r.errors.join("\n");
      expect(said).toMatch(/published the slide deck as version 1, but its \.pptx did not reach the hub/);
      expect(said).toContain(
        `Do not put the outline again, which would publish another version. Send the .pptx alone: agent-hub deck pptx ${path.join(dir, "deck.pptx")} --version 1`
      );
      expect(hub.decks.get(agentId)?.version).toBe(1);

      // Act
      const sent = await cli(["deck", "pptx", path.join(dir, "deck.pptx"), "--version", "1"], { sid });

      // Assert
      expect(sent.code, sent.errors.join("\n")).toBe(0);
      expect(sent.text()).toMatch(/sent the \.pptx for version 1 of the slide deck/);
      expect(hub.decks.get(agentId)?.pptx.get(1)).toEqual(PPTX);
      expect(hub.decks.get(agentId)?.version).toBe(1);
    });

    it("should say why deck pptx sent nothing when the version is not there or too old to keep a .pptx", async () => {
      // Arrange
      const { sid, agentId } = await session();
      const dir = workDir();
      for (let i = 0; i < 4; i++) {
        hub.writeDeckAsUser(agentId, outline({ asset: `sha256:${digest(PNG)}` }), { [digest(PNG)]: PNG });
      }

      // Act
      const missing = await cli(["deck", "pptx", path.join(dir, "deck.pptx"), "--version", "9"], { sid });
      const old = await cli(["deck", "pptx", path.join(dir, "deck.pptx"), "--version", "1"], { sid });

      // Assert
      expect(missing.code).toBe(1);
      expect(missing.errors.join("\n")).toMatch(/the deck has no version 9/);
      expect(old.code).toBe(1);
      expect(old.errors.join("\n")).toMatch(/version 1 is older than the latest 3/);
    });

    it("should say the session has no deck when deck get runs outside a conversation", async () => {
      // Arrange
      const { sid } = await session({ conversation: false });

      // Act
      const r = await cli(["deck", "get"], { sid });

      // Assert
      expect(r.code).toBe(1);
      expect(r.errors.join("\n")).toMatch(/not a CFT Workspace conversation, so it has no slide deck/);
    });

    it("should refuse arguments it does not take, a file that is not a .pptx and an outline that is not JSON", async () => {
      // Arrange
      const { sid } = await session();
      const dir = workDir();
      fs.writeFileSync(path.join(dir, "broken.json"), "{");
      fs.writeFileSync(path.join(dir, "list.json"), "[]");
      const file = path.join(dir, "outline.json");

      // Act & Assert
      for (const args of [
        ["deck"],
        ["deck", "edit"],
        ["deck", "get", "extra"],
        ["deck", "get", "--slide", "has space"],
        ["deck", "put"],
        ["deck", "put", file, "extra"],
        ["deck", "put", file, "--base", "latest"],
        ["deck", "put", file, "--summary", " "],
        ["deck", "put", file, "--pptx", path.join(dir, "pipeline.png")],
        ["deck", "put", path.join(dir, "missing.json")],
        ["deck", "put", path.join(dir, "broken.json")],
        ["deck", "put", path.join(dir, "list.json")],
        ["deck", "pptx"],
        ["deck", "pptx", path.join(dir, "deck.pptx")],
        ["deck", "pptx", path.join(dir, "deck.pptx"), "--version", "0"],
        ["deck", "pptx", path.join(dir, "deck.pptx"), "--version", "1", "extra"],
        ["deck", "pptx", path.join(dir, "pipeline.png"), "--version", "1"]
      ]) {
        expect((await cli(args, { sid })).code, args.join(" ")).toBe(2);
      }
    });
  });

  const EXPORT = "5b0e7c1a-1111-4222-8333-444455556666";
  const reported = (agentId: string) => hub.jiraReports.filter((r) => r.agent_id === agentId);

  it("should report the ticket's key, or why there is none, when jira report runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act
    const created = await cli(["jira", "report", EXPORT, "--key", "VIBE-701"], { sid });
    const failed = await cli(["jira", "report", EXPORT, "--error", "  Story is not an issue type of VIBE  "], { sid });

    // Assert
    expect(created.code, created.errors.join("\n")).toBe(0);
    expect(created.text()).toMatch(/reported VIBE-701 for export/);
    expect(failed.code).toBe(0);
    expect(reported(agentId)).toEqual([
      { agent_id: agentId, export_id: EXPORT, key: "VIBE-701" },
      { agent_id: agentId, export_id: EXPORT, error: "Story is not an issue type of VIBE" }
    ]);
  });

  it("should refuse a report that is not one key or one reason for an export id", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act & Assert
    for (const args of [
      ["jira"],
      ["jira", "report", "not-an-id", "--key", "VIBE-1"],
      ["jira", "report", EXPORT],
      ["jira", "report", EXPORT, "--key", "VIBE-1", "--error", "both"],
      ["jira", "report", EXPORT, "--key", "vibe one"],
      ["jira", "report", EXPORT, "--error", " "]
    ]) {
      const r = await cli(args, { sid });
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(reported(agentId)).toHaveLength(0);
  });

  // A twg that is signed in, on PATH ahead of any real one. It logs each call's argv as one JSON line, so the test
  // sees exactly the arguments it was given, and answers a create as twg 1.3 does, numbering each ticket it makes.
  function fakeTwg(): { env: Env; calls: () => string[][] } {
    const bin = fs.mkdtempSync(path.join(home.root, "twg-bin-"));
    const logFile = path.join(bin, "twg.log");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + "\\n");
if (args[0] === "whoami") { console.log("olive@hmcts.net"); process.exit(0); }
if (args[0] === "jira") {
  const n = fs.readFileSync(${JSON.stringify(logFile)}, "utf8").split("\\n").filter((l) => l.includes('"workitem"')).length;
  console.log(JSON.stringify({ data: { key: "VIBE-" + (700 + n), id: "1000" + n } }));
  process.exit(0);
}
console.error("unexpected twg " + args.join(" "));
process.exit(2);
`;
    fs.writeFileSync(path.join(bin, "twg"), script, { mode: 0o755 });
    return {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      calls: () =>
        fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as string[])
    };
  }

  it("should create the ticket with twg, report its key and print where it is when jira export runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();
    hub.editArtefactAsUser(agentId, "# Stories\n\nAs a claimant, $(whoami)…", 'Fee "stories"');
    const twg = fakeTwg();

    // Act
    const r = await cli(["jira", "export", EXPORT, "--project", "VIBE", "--type", "Story", "--labels", "hmcts-assistant"], { sid, extraEnv: twg.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/created VIBE-701 for export .*https:\/\/hmcts\.atlassian\.net\/browse\/VIBE-701/);
    expect(twg.calls()).toEqual([
      ["whoami"],
      [
        "jira",
        "workitem",
        "create",
        "--space=VIBE",
        "--type=Story",
        '--summary=Fee "stories"',
        "--description=# Stories\n\nAs a claimant, $(whoami)…",
        "--description-format=markdown",
        "--labels=hmcts-assistant",
        "--output=json",
        "--output-summary=none"
      ]
    ]);
    expect(reported(agentId)).toEqual([{ agent_id: agentId, export_id: EXPORT, key: "VIBE-701" }]);
  });

  it("should report the ticket it already made and create no second one when jira export runs again for the export", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "6c1f8d2b-2222-4333-8444-555566667777";
    hub.editArtefactAsUser(agentId, "# Stories", "Fee stories");
    const twg = fakeTwg();
    const args = ["jira", "export", exportId, "--project", "VIBE", "--type", "Story"];
    await cli(args, { sid, extraEnv: twg.env });

    // Act
    const r = await cli(args, { sid, extraEnv: twg.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/already created VIBE-701/);
    expect(twg.calls().filter((call) => call[0] === "jira")).toHaveLength(1);
    expect(reported(agentId)).toEqual([
      { agent_id: agentId, export_id: exportId, key: "VIBE-701" },
      { agent_id: agentId, export_id: exportId, key: "VIBE-701" }
    ]);
  });

  it("should exit 1 and say no ticket was made when the conversation's document is empty", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "7d2a9e3c-3333-4444-8555-666677778888";
    const twg = fakeTwg();

    // Act
    const r = await cli(["jira", "export", exportId, "--project", "VIBE", "--type", "Story"], { sid, extraEnv: twg.env });

    // Assert
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/no ticket was created for export .*document is empty/);
    expect(reported(agentId)).toEqual([{ agent_id: agentId, export_id: exportId, error: "The document is empty, so there was nothing to export." }]);
  });

  it("should refuse a jira export without its project and type, or with the other action's flags", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act & Assert
    for (const args of [
      ["jira", "export", EXPORT],
      ["jira", "export", EXPORT, "--project", "vibe", "--type", "Story"],
      ["jira", "export", EXPORT, "--project", "VIBE", "--type", "User Story"],
      ["jira", "export", EXPORT, "--project", "VIBE", "--type", "Story", "--labels", "a,b c"],
      ["jira", "export", EXPORT, "--project", "VIBE", "--type", "Story", "--key", "VIBE-1"],
      ["jira", "report", EXPORT, "--key", "VIBE-1", "--project", "VIBE"]
    ]) {
      const r = await cli(args, { sid });
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(reported(agentId)).toHaveLength(0);
  });

  const githubReported = (agentId: string) => hub.githubReports.filter((r) => r.agent_id === agentId);

  it("should report the issue's number, or why there is none, when github report runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act
    const created = await cli(["github", "report", EXPORT, "--number", "42"], { sid });
    const failed = await cli(["github", "report", EXPORT, "--error", "  Issues are turned off  "], { sid });

    // Assert
    expect(created.code, created.errors.join("\n")).toBe(0);
    expect(created.text()).toMatch(/reported issue #42 for export/);
    expect(failed.code).toBe(0);
    expect(githubReported(agentId)).toEqual([
      { agent_id: agentId, export_id: EXPORT, number: 42 },
      { agent_id: agentId, export_id: EXPORT, error: "Issues are turned off" }
    ]);
  });

  // A gh that is signed in, on PATH ahead of any real one. It logs each call's argv and the body file it was given,
  // and answers a create as gh does, with the new issue's link on its last line, numbering each issue it makes.
  function fakeGh(): { env: Env; calls: () => { args: string[]; body: string }[] } {
    const bin = fs.mkdtempSync(path.join(home.root, "gh-bin-"));
    const logFile = path.join(bin, "gh.log");
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const file = args.find((a) => a.startsWith("--body-file="));
const body = file ? fs.readFileSync(file.slice("--body-file=".length), "utf8") : "";
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, body }) + "\\n");
if (args[0] === "project" && args[1] === "item-add") { process.exit(0); }
if (args[0] === "label" && args[1] === "create") { console.error("label already exists"); process.exit(1); }
if (args[0] === "issue" && args[1] === "edit") { process.exit(0); }
if (args[0] === "issue" && args[1] === "create") {
  const repo = args.find((a) => a.startsWith("--repo=")).slice("--repo=".length);
  const n = fs.readFileSync(${JSON.stringify(logFile)}, "utf8").split("\\n").filter((l) => l.includes('"create"')).length;
  console.log("https://github.com/" + repo + "/issues/" + (40 + n));
  process.exit(0);
}
console.error("unexpected gh " + args.join(" "));
process.exit(2);
`;
    fs.writeFileSync(path.join(bin, "gh"), script, { mode: 0o755 });
    return {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      calls: () =>
        fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as { args: string[]; body: string })
    };
  }

  it("should create the issue with gh, report its number and print where it is when github export runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();
    hub.editArtefactAsUser(agentId, "# Stories\n\nAs a claimant, $(whoami)…", 'Fee "stories"');
    const gh = fakeGh();

    // Act
    const r = await cli(["github", "export", EXPORT, "--repo", "hmcts/cft-workspace"], { sid, extraEnv: gh.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/created hmcts\/cft-workspace#41 for export .*https:\/\/github\.com\/hmcts\/cft-workspace\/issues\/41/);
    expect(gh.calls()).toEqual([
      {
        args: ["issue", "create", "--repo=hmcts/cft-workspace", '--title=Fee "stories"', expect.stringMatching(/^--body-file=.*\.md$/)],
        body: "# Stories\n\nAs a claimant, $(whoami)…"
      }
    ]);
    expect(githubReported(agentId)).toEqual([{ agent_id: agentId, export_id: EXPORT, number: 41 }]);
  });

  it("should add the issue to the Project given and say so when github export runs with --project", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "8e3b0f4d-4444-4555-8666-777788889999";
    hub.editArtefactAsUser(agentId, "# Stories", "Fee stories");
    const gh = fakeGh();

    // Act
    const r = await cli(["github", "export", exportId, "--repo", "hmcts/cft-workspace", "--project", "hmcts/12"], { sid, extraEnv: gh.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/created hmcts\/cft-workspace#41 on Project 12 of hmcts for export/);
    expect(gh.calls().map((call) => call.args.slice(0, 2))).toEqual([
      ["issue", "create"],
      ["project", "item-add"]
    ]);
    expect(gh.calls()[1]?.args).toEqual(["project", "item-add", "12", "--owner=hmcts", "--url=https://github.com/hmcts/cft-workspace/issues/41"]);
    expect(githubReported(agentId)).toEqual([{ agent_id: agentId, export_id: exportId, number: 41 }]);
  });

  it("should label the issue, making the label if need be, when github export runs with --labels", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "9f4c1a5e-5555-4666-8777-88889999aaaa";
    hub.editArtefactAsUser(agentId, "# Stories", "Fee stories");
    const gh = fakeGh();

    // Act
    const r = await cli(["github", "export", exportId, "--repo", "hmcts/cft-workspace", "--labels", "cft-workspace"], { sid, extraEnv: gh.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).not.toMatch(/no label/);
    expect(gh.calls().map((call) => call.args.slice(0, 2))).toEqual([
      ["issue", "create"],
      ["label", "create"],
      ["issue", "edit"]
    ]);
    expect(gh.calls()[2]?.args).toEqual(["issue", "edit", "41", "--repo=hmcts/cft-workspace", "--add-label=cft-workspace"]);
  });

  it("should report the issue it already made and create no second one when github export runs again for the export", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "6c1f8d2b-2222-4333-8444-555566667777";
    hub.editArtefactAsUser(agentId, "# Stories", "Fee stories");
    const gh = fakeGh();
    const args = ["github", "export", exportId, "--repo", "hmcts/cft-workspace"];
    await cli(args, { sid, extraEnv: gh.env });

    // Act
    const r = await cli(args, { sid, extraEnv: gh.env });

    // Assert
    expect(r.code, r.errors.join("\n")).toBe(0);
    expect(r.text()).toMatch(/already created hmcts\/cft-workspace#41/);
    expect(gh.calls()).toHaveLength(1);
    expect(githubReported(agentId)).toEqual([
      { agent_id: agentId, export_id: exportId, number: 41 },
      { agent_id: agentId, export_id: exportId, number: 41 }
    ]);
  });

  it("should exit 1 and say no issue was made when the conversation's document is empty", async () => {
    // Arrange
    const { sid, agentId } = await session();
    const exportId = "7d2a9e3c-3333-4444-8555-666677778888";
    const gh = fakeGh();

    // Act
    const r = await cli(["github", "export", exportId, "--repo", "hmcts/cft-workspace"], { sid, extraEnv: gh.env });

    // Assert
    expect(r.code).toBe(1);
    expect(r.text()).toMatch(/no issue was created for export .*document is empty/);
    expect(githubReported(agentId)).toEqual([{ agent_id: agentId, export_id: exportId, error: "The document is empty, so there was nothing to export." }]);
  });

  it("should refuse a github export or report that is not well formed", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act & Assert
    for (const args of [
      ["github"],
      ["github", "export", EXPORT],
      ["github", "export", "not-an-id", "--repo", "hmcts/cft-workspace"],
      ["github", "export", EXPORT, "--repo", "cft-workspace"],
      ["github", "export", EXPORT, "--repo", "-x/../y"],
      ["github", "export", EXPORT, "--repo", "hmcts/cft-workspace", "--number", "1"],
      ["github", "export", EXPORT, "--repo", "hmcts/cft-workspace", "--project", "12"],
      ["github", "export", EXPORT, "--repo", "hmcts/cft-workspace", "--project", "hmcts/zero"],
      ["github", "export", EXPORT, "--repo", "hmcts/cft-workspace", "--labels", "a b"],
      ["github", "report", EXPORT],
      ["github", "report", EXPORT, "--number", "0"],
      ["github", "report", EXPORT, "--number", "1", "--error", "both"],
      ["github", "report", EXPORT, "--error", " "],
      ["github", "report", EXPORT, "--number", "1", "--repo", "hmcts/cft-workspace"]
    ]) {
      const r = await cli(args, { sid });
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(githubReported(agentId)).toHaveLength(0);
  });

  const confluenceReported = (agentId: string) => hub.confluenceReports.filter((r) => r.agent_id === agentId);

  it("should report the page, or why there is none, when confluence report runs in a conversation", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act
    const created = await cli(["confluence", "report", EXPORT, "--page-id", "300000001", "--title", "Guide"], { sid });
    const failed = await cli(["confluence", "report", EXPORT, "--error", "  No permission  "], { sid });

    // Assert
    expect(created.code, created.errors.join("\n")).toBe(0);
    expect(created.text()).toMatch(/reported page 300000001 for export/);
    expect(failed.code).toBe(0);
    expect(confluenceReported(agentId)).toEqual([
      { agent_id: agentId, export_id: EXPORT, page_id: "300000001", title: "Guide" },
      { agent_id: agentId, export_id: EXPORT, error: "No permission" }
    ]);
  });

  it("should refuse a confluence command that is not one page or one reason for an export id", async () => {
    // Arrange
    const { sid, agentId } = await session();

    // Act & Assert
    for (const args of [
      ["confluence"],
      ["confluence", "report", "not-an-id", "--page-id", "1"],
      ["confluence", "report", EXPORT],
      ["confluence", "report", EXPORT, "--page-id", "1", "--error", "both"],
      ["confluence", "report", EXPORT, "--page-id", "one"],
      ["confluence", "report", EXPORT, "--error", "x", "--title", "t"],
      ["confluence", "report", EXPORT, "--page-id", "1", "--space-id", "2"],
      ["confluence", "export", EXPORT, "--space-id", "CCD", "--parent-id", "1"],
      ["confluence", "export", EXPORT, "--space-id", "1"]
    ]) {
      const r = await cli(args, { sid });
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(confluenceReported(agentId)).toHaveLength(0);
  });

  it("should say the session has no Jira export when jira report runs outside a conversation", async () => {
    // Arrange
    const { sid } = await session({ conversation: false });

    // Act
    const r = await cli(["jira", "report", EXPORT, "--key", "VIBE-1"], { sid });

    // Assert
    expect(r.code).toBe(1);
    expect(r.errors.join("\n")).toMatch(/not a CFT Workspace conversation, so it has no Jira export/);
  });
});

describe("the CLI as a child process, through bin/agent-hub", () => {
  // enable → bridge → mock hub → fake inbox socket → ack, plus the Stop worker and SessionEnd, all against
  // in-process fakes and a throwaway HOME. Nothing touches a real session socket or ~/.claude.
  const SID = "integration-sess-0001";
  const TOKEN = "fake-inbox-token";

  let home: TempClaudeHome;
  let hub: MockHub;
  let url: string;
  let inbox: net.Server;
  let fakeClaude: ReturnType<typeof spawn>;
  let env: Record<string, string>;
  let agentId: string;
  const received: Record<string, unknown>[][] = [];
  const inboxWaiters: (() => void)[] = [];

  function startInbox(socketPath: string): Promise<net.Server> {
    const server = net.createServer((conn) => {
      let buf = "";
      const lines: Record<string, unknown>[] = [];
      conn.on("data", (d) => {
        buf += d;
        let i = buf.indexOf("\n");
        while (i !== -1) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
          i = buf.indexOf("\n");
        }
      });
      conn.on("end", () => {
        received.push(lines);
        for (const w of inboxWaiters.splice(0)) {
          w();
        }
      });
    });
    return new Promise((resolve) => {
      server.listen(socketPath, () => resolve(server));
    });
  }

  async function waitForInbox(count: number, timeoutMs = 8000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`inbox got ${received.length} connection(s), wanted ${count}`);
      }
      await new Promise<void>((r) => {
        inboxWaiters.push(r);
        setTimeout(r, 200);
      });
    }
    return received[count - 1] as Record<string, unknown>[];
  }

  type Run = { status: number | null; stdout: string; stderr: string };

  function run(args: string[], { input, extraEnv = {}, cwd }: { input?: string; extraEnv?: Record<string, string>; cwd?: string } = {}): Promise<Run> {
    return new Promise((resolve) => {
      const child = spawn("bash", [BIN, ...args], { cwd: cwd ?? home.root, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => {
        stdout += d;
      });
      child.stderr?.on("data", (d) => {
        stderr += d;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 25000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, stdout, stderr });
      });
      child.stdin?.end(input ?? "");
    });
  }

  const stateFile = (name: string) => path.join(home.hub, SID, name);
  const bridgePid = () => Number.parseInt(fs.readFileSync(stateFile("bridge.pid"), "utf8"), 10);

  async function waitUntil(fn: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function exited(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  beforeAll(async () => {
    home = tempClaudeHome();
    hub = createMockHub({ pingMs: 200 });
    url = await hub.listen();
    const socketPath = path.join(home.root, "inbox.sock");
    inbox = await startInbox(socketPath);
    fakeClaude = spawn("sleep", ["300"], { stdio: "ignore" });
    fs.writeFileSync(
      path.join(home.claude, "sessions", `${fakeClaude.pid}.json`),
      JSON.stringify({ pid: fakeClaude.pid, sessionId: SID, cwd: home.root, name: "itest-session", messagingSocketPath: socketPath })
    );

    const haiku = path.join(home.root, "fake-claude");
    fs.writeFileSync(
      haiku,
      `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(home.root, "haiku-call.json"))}, JSON.stringify({ argv: process.argv.slice(2), child: process.env.AGENT_HUB_CHILD, cwd: process.cwd() }));
const result = { publish: { topics: ['pcs-api'], title: 'Claim table renamed', body: 'V030 renames cases to claim.' }, notify: '#' + process.env.ITEST_FEED_ID + ' is about the same table; run agent-hub read ' + process.env.ITEST_FEED_ID };
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify(result) }));
`,
      { mode: 0o755 }
    );

    env = {
      PATH: process.env.PATH as string,
      ...home.env,
      AGENT_HUB_CLI_JS: CLI_SOURCE,
      CLAUDE_PROJECT_DIR: home.root,
      AGENT_HUB_URL: url,
      AGENT_HUB_DEV_USER: DEV_USER,
      AGENT_HUB_HEARTBEAT_MS: "300",
      AGENT_HUB_TRANSCRIPT_MS: "200",
      AGENT_HUB_CLAUDE_BIN: haiku,
      CLAUDE_CODE_SESSION_ID: SID,
      CLAUDE_CODE_MESSAGING_TOKEN: TOKEN
    };
  });

  afterAll(async () => {
    try {
      process.kill(bridgePid(), "SIGKILL");
    } catch {}
    fakeClaude?.kill("SIGKILL");
    inbox?.close();
    await hub?.close();
    home?.cleanup();
  });

  it("should register, subscribe and start a bridge that opens the stream when enable runs", async () => {
    // Act
    const r = await run(["enable", "pcs-api", "HDPI-1234"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/enabled as @itest-session/);
    expect(r.stdout).toMatch(/subscribed topics: hdpi-1234, pcs-api/);
    const register = await hub.waitFor((c) => c.path === "/api/agent/register");
    expect(register.body.session_id).toBe(SID);
    expect(register.body.name).toBe("itest-session");
    expect(register.headers["x-dev-user"]).toBe(DEV_USER);
    agentId = [...hub.agents.values()][0]?.id as string;
    await hub.waitFor((c) => c.method === "GET" && c.path === `/api/agent/${agentId}/stream`);
    expect(fs.existsSync(stateFile("enabled"))).toBe(true);
  });

  it("should write the owner's direct message from the UI to the inbox socket as their own, then ack it", async () => {
    // Act
    const msg = hub.sendDirectFromOwner(agentId, "Please check the claim migration.");
    const lines = await waitForInbox(1);

    // Assert
    expect(lines[0]).toEqual({ type: "auth", token: TOKEN });
    expect(lines[1]?.type).toBe("user");
    const message = lines[1]?.message as { role: string; content: string };
    expect(message.role).toBe("user");
    expect(message.content).toMatch(new RegExp(`^\\[agent-hub\\] Direct message #${msg.id} from your user, Me Tester, typed into the CFT Workspace chat app`));
    expect(message.content).toMatch(/This IS your user/);
    expect(message.content.endsWith("Please check the claim migration.")).toBe(true);
    await hub.waitFor((c) => c.method === "POST" && c.path === `/api/agent/${agentId}/deliveries/${msg.id}/ack`);
    expect(hub.deliveries.get(`${msg.id}:${agentId}`)?.state).toBe("delivered");
  });

  it("should carry the status the hooks record and the registry name on the heartbeats", async () => {
    // Act
    let r = await run(["hook", "UserPromptSubmit"], { input: JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit" }) });

    // Assert
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const n = hub.calls.length;
    await hub.waitFor((c) => hub.calls.indexOf(c) >= n && c.path.endsWith("/heartbeat") && c.body.status === "busy");
    r = await run(["hook", "Stop"], { input: JSON.stringify({ session_id: SID, transcript_path: "/nonexistent" }) });
    expect(r.status).toBe(0);
    await hub.waitFor((c) => c.path.endsWith("/heartbeat") && c.body.status === "idle" && c.body.name === "itest-session");
    await waitUntil(() => !fs.existsSync(stateFile("worker.lock")), "the first stop worker to finish");
  });

  it("should send a reply to the message author via reply_to_message", async () => {
    // Arrange
    const original = hub.sendDirectFromOwner(agentId, "ping");
    await waitForInbox(2);

    // Act
    const r = await run(["reply", original.id, "pong", "from", "the", "agent"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/direct`);
    expect(call.body).toEqual({ reply_to_message: original.id, body: "pong from the agent" });
  });

  it("should refuse secret-shaped text and publish clean text from stdin when post runs", async () => {
    // Arrange: built at runtime so no secret-shaped literal sits in the repo.
    const secret = `${"gh"}p_${"Q".repeat(30)}`;

    // Act
    let r = await run(["post", "--topics", "pcs-api", "--title", "Leak", "--body", `token ${secret}`]);

    // Assert
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/secret-shaped/);
    r = await run(["post", "--topics", "pcs-api,Database", "--title", "Migration done"], { input: "V030 applied in AAT." });
    expect(r.status, r.stderr).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts`);
    expect(call.body).toEqual({ topics: ["pcs-api", "database"], title: "Migration done", body: "V030 applied in AAT." });
    r = await run(["post", "--topics", "Not A Slug", "--title", "x", "--body", "y"]);
    expect(r.status).toBe(2);
  });

  it("should accept ten topics and refuse eleven when post runs", async () => {
    // Arrange
    const ten = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

    // Act
    let r = await run(["post", "--topics", ten.join(","), "--title", "Ten topics", "--body", "y"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    const call = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Ten topics");
    expect(call.body.topics).toEqual(ten);
    r = await run(["post", "--topics", [...ten, "t11"].join(","), "--title", "Eleven topics", "--body", "y"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/at most 10 topics/);
  });

  it("should read by id and by topic", async () => {
    // Arrange
    const other = hub.addPost({ topics: ["pcs-api"], title: "Heads up", bodyText: "cases table is going away", fromAgent: "bob-pcs" });

    // Act and assert
    let r = await run(["read", other.id]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Heads up\ncases table is going away/);
    r = await run(["read", "pcs-api"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`#${other.id} \\[pcs-api\\]`));
    expect(r.stdout, "a topic read includes the session's own posts").toMatch(/Migration done/);
    r = await run(["read"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`#${other.id} \\[pcs-api\\]`));
    expect(r.stdout, "own posts are not in the feed").not.toMatch(/Migration done/);
  });

  it("should read unsubscribed topics and return the newest posts when read names a topic", async () => {
    // Arrange
    const posts = [];
    for (let i = 0; i < 25; i++) {
      posts.push(hub.addPost({ topics: ["zz-unsubscribed"], title: `Busy ${i}`, bodyText: "x", fromAgent: "dave-other" }));
    }

    // Act
    const r = await run(["read", "zz-unsubscribed", "--limit", "5"]);
    const since = await run(["read", "zz-unsubscribed", "--since", posts[21]?.id as string, "--limit", "100"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toMatch(/subscribe first/);
    expect([...r.stdout.matchAll(/Busy (\d+)/g)].map((m) => Number(m[1]))).toEqual([20, 21, 22, 23, 24]);
    expect(since.status, since.stderr).toBe(0);
    expect([...since.stdout.matchAll(/Busy (\d+)/g)].map((m) => Number(m[1]))).toEqual([22, 23, 24]);
  });

  it("should return subscribed and named topics and the direct messages the session saw both ways when chat runs", async () => {
    // Act
    const r = await run(["chat", "--topics", "zz-unsubscribed", "--limit", "3"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    const chat = JSON.parse(r.stdout);
    expect(chat.enabled).toBe(true);
    expect(chat.agent.id).toBe(agentId);
    expect(chat.subscribed).toEqual(["hdpi-1234", "pcs-api"]);
    expect(Object.keys(chat.posts).sort(compareStrings)).toEqual(["hdpi-1234", "pcs-api", "zz-unsubscribed"]);
    expect(chat.posts["zz-unsubscribed"].map((m: { title: string }) => m.title)).toEqual(["Busy 22", "Busy 23", "Busy 24"]);
    expect(chat.posts["pcs-api"].some((m: { title: string }) => m.title === "Heads up")).toBe(true);
    const owner = { key: "user:me@example.com", name: "Me Tester" };
    const ping = chat.directs.find((d: { body: string }) => d.body === "ping");
    expect([ping.direction, ping.peer]).toEqual(["in", owner]);
    const pong = chat.directs.find((d: { body: string }) => d.body === "pong from the agent");
    expect([pong.direction, pong.peer, pong.in_reply_to]).toEqual(["out", owner, ping.id]);
    expect(chat.errors.length).toBe(0);
  });

  it("should list every topic and the agents to message when directory runs", async () => {
    // Act
    const r = await run(["directory"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    const dir = JSON.parse(r.stdout);
    expect(dir.topics.some((t: { slug: string }) => t.slug === "zz-unsubscribed")).toBe(true);
    expect(dir.agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  it("should run a detached worker from the Stop hook that publishes and holds a note the next prompt picks up", async () => {
    // Arrange
    const feed = hub.addPost({ topics: ["pcs-api"], title: "Claim rename planned", bodyText: "We are renaming cases.", fromAgent: "carol-pcs" });
    const transcript = path.join(home.root, "transcript.jsonl");
    const entry = (type: string, content: unknown) => `${JSON.stringify({ type, message: { role: type, content } })}\n`;
    const edit = [{ type: "tool_use", name: "Edit", input: { file_path: path.join(home.root, "apps", "zz-itest", "zz-itest-repo", "src", "a.ts") } }];
    fs.writeFileSync(transcript, entry("user", "rename the cases table") + entry("assistant", edit) + entry("assistant", "Done: V030 renames cases to claim."));
    const inboxBefore = received.length;
    const registers = hub.calls.filter((c) => c.path === "/api/agent/register").length;

    // Act
    const r = await run(["hook", "Stop"], {
      input: JSON.stringify({ session_id: SID, transcript_path: transcript, hook_event_name: "Stop" }),
      extraEnv: { ITEST_FEED_ID: feed.id }
    });

    // Assert
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");

    const post = await hub.waitFor((c) => c.path === `/api/agent/${agentId}/posts` && c.body.title === "Claim table renamed", 20000);
    expect(post.body.topics).toEqual(["pcs-api"]);

    const call = JSON.parse(fs.readFileSync(path.join(home.root, "haiku-call.json"), "utf8"));
    expect(call.argv.slice(0, 5)).toEqual(["-p", "--model", "haiku", "--settings", '{"disableAllHooks":true}']);
    expect(call.argv.includes("--bare")).toBe(false);
    expect(call.argv.includes("--output-format")).toBe(true);
    expect(call.child).toBe("1");
    expect(fs.realpathSync(call.cwd), "the summariser must not load the workspace CLAUDE.md").not.toBe(fs.realpathSync(home.root));
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(path.join(home.hub, "summariser-cwd")));
    expect(call.argv.at(-1)).toMatch(/rename the cases table/);

    await waitUntil(() => !fs.existsSync(stateFile("worker.lock")), "the worker to release its lock");
    const cursors = JSON.parse(fs.readFileSync(stateFile("cursors.json"), "utf8"));
    expect(cursors.transcript_offset).toBe(fs.statSync(transcript).size);
    expect(cursors.feed_cursor).toBe(feed.id);
    expect(hub.agents.get(agentId)?.read_cursor).toBe(Number(feed.id));
    expect(received.length, "the note went through the inbox and started a turn").toBe(inboxBefore);
    const ctx = await run(["hook", "UserPromptContext"], { input: JSON.stringify({ session_id: SID, hook_event_name: "UserPromptSubmit", prompt: "next" }) });
    expect(ctx.status).toBe(0);
    const out = JSON.parse(ctx.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    expect(out.hookSpecificOutput.additionalContext).toMatch(new RegExp(`#${feed.id} is about the same table`));
    expect(fs.existsSync(stateFile("held-notes.jsonl"))).toBe(false);

    expect(hub.calls.filter((c) => c.path === "/api/agent/register").length).toBe(registers + 1);
    expect(hub.agents.get(agentId)?.repo).toBe("zz-itest-repo");
    expect(hub.agents.get(agentId)?.branch).toBeNull();
    expect(["zz-itest-repo", "zz-itest"].every((t) => hub.subscriptions.get(agentId)?.has(t))).toBe(true);
    expect(JSON.parse(fs.readFileSync(stateFile("agent.json"), "utf8")).repo).toBe("zz-itest-repo");
  });

  it("should upload the hook-recorded transcript, with transcript off|on|status controlling it", async () => {
    // Arrange
    const transcript = fs.readFileSync(stateFile("transcript"), "utf8").trim();
    const line = (id: string, text: string) =>
      `${JSON.stringify({ type: "user", uuid: id, timestamp: new Date().toISOString(), message: { role: "user", content: text } })}\n`;
    const uploaded = () => [...(hub.transcripts.get(agentId)?.keys() ?? [])];
    fs.appendFileSync(transcript, line("itest-a", "first upload"));
    await waitUntil(() => uploaded().includes("itest-a:0"), "the upload");

    // Act and assert
    let r = await run(["transcript", "status"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/transcript: uploaded while comms are enabled/);
    expect(r.stdout).toMatch(new RegExp(`uploaded: {3}to byte \\d+ of ${fs.statSync(transcript).size}`));

    r = await run(["transcript", "off"]);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(stateFile("transcript-off"))).toBe(true);
    fs.appendFileSync(transcript, line("itest-b", "private"));
    r = await run(["transcript", "status"]);
    expect(r.stdout).toMatch(/transcript: off for this session/);

    r = await run(["transcript", "on"]);
    expect(r.status, r.stderr).toBe(0);
    fs.appendFileSync(transcript, line("itest-c", "public again"));
    await waitUntil(() => uploaded().includes("itest-c:0"), "the upload after on");
    expect(uploaded().includes("itest-b:0")).toBe(false);

    r = await run(["transcript", "sideways"]);
    expect(r.status).toBe(2);
  });

  it("should stop the bridge and mark the agent offline when SessionEnd runs", async () => {
    // Arrange
    const pid = bridgePid();

    // Act
    const r = await run(["hook", "SessionEnd"], { input: JSON.stringify({ session_id: SID, reason: "logout" }) });

    // Assert
    expect(r.status).toBe(0);
    await hub.waitFor((c) => c.path === `/api/agent/${agentId}/offline`);
    await waitUntil(() => !fs.existsSync(stateFile("bridge.pid")), "the pidfile to go");
    expect(exited(pid)).toBe(true);
  });

  it("should restart the bridge on SessionStart, redeliver unacked messages and exit when Claude dies", async () => {
    // Arrange
    const queued = hub.sendDirectFromOwner(agentId, "sent while offline");
    const before = received.length;
    const n = hub.calls.length;

    // Act
    const r = await run(["hook", "SessionStart"], { input: JSON.stringify({ session_id: SID, source: "resume" }) });

    // Assert
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/comms are enabled for this session as @itest-session/);
    const lines = await waitForInbox(before + 1);
    expect((lines[1]!.message as { content: string }).content).toMatch(new RegExp(`#${queued.id} `));
    await hub.waitFor((c) => c.path.endsWith(`/deliveries/${queued.id}/ack`));

    const pid = bridgePid();
    fakeClaude.kill("SIGKILL");
    await hub.waitFor((c) => hub.calls.indexOf(c) >= n && c.path === `/api/agent/${agentId}/offline`);
    await waitUntil(() => !fs.existsSync(stateFile("bridge.pid")), "the bridge to exit");
    await waitUntil(() => exited(pid), "the bridge process to exit");
  });

  it("should remove the enabled flag so the hooks go quiet when disable runs", async () => {
    // Act
    const r = await run(["disable"]);

    // Assert
    expect(r.status, r.stderr).toBe(0);
    expect(fs.existsSync(stateFile("enabled"))).toBe(false);
    const logBefore = fs.readFileSync(stateFile("log"), "utf8");
    await run(["hook", "Stop"], { input: JSON.stringify({ session_id: SID }) });
    await run(["hook", "UserPromptSubmit"], { input: JSON.stringify({ session_id: SID }) });
    expect(fs.readFileSync(stateFile("log"), "utf8"), "log is silent after disable").toBe(logBefore);
  });

  describe("virtual watch-ports", () => {
    const VID = "0f8a6a1e-1234-4000-8000-000000000001";
    const LAUNCH = `launch-${"p".repeat(16)}`;
    const FIXTURES = fileURLToPath(new URL("./__fixtures__/proc-net", import.meta.url));
    let portsHub: MockHub;
    let portsUrl: string;

    const reports = () => (portsHub.virtuals.get(VID)?.ports ?? []) as Record<string, unknown>[];

    beforeAll(async () => {
      portsHub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: { oid: "oid-owner" } } } });
      portsUrl = await portsHub.listen();
    });

    afterAll(async () => {
      await portsHub.close();
    });

    it("should report the ports from AGENT_HUB_PROC_NET, exit 0 and stop on SIGTERM", async () => {
      // Arrange
      const before = reports().length;
      const childEnv = {
        PATH: process.env.PATH as string,
        HOME: os.tmpdir(),
        AGENT_HUB_CLI_JS: CLI_SOURCE,
        AGENT_HUB_URL: portsUrl,
        AGENT_HUB_VIRTUAL_AGENT_ID: VID,
        AGENT_HUB_LAUNCH_TOKEN: LAUNCH,
        AGENT_HUB_PROC_NET: FIXTURES,
        AGENT_HUB_PORTS_MS: "20",
        VIRTUAL_AGENT_IGNORE_PORTS: "4000"
      };

      // Act
      const child = spawn("bash", [BIN, "virtual", "watch-ports"], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d;
      });
      const deadline = Date.now() + 20000;
      while (reports().length === before && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200));
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
        child.kill("SIGTERM");
      });

      // Assert
      expect(code, stderr).toBe(0);
      expect(reports().slice(before), "one report, not one per read").toEqual([{ ports: [3000, 8080], local_only: [5173, 8081, 9090] }]);
      expect(stderr).toMatch(/ports: reported 3000, 8080; on 127\.0\.0\.1 only: 5173, 8081, 9090/);
    });
  });

  describe("auto-enable through the wrapper", () => {
    const DEAD_PID = 999999999;
    let autoHome: TempClaudeHome;
    let autoHub: MockHub;
    let autoUrl: string;

    const hookEnv = (hubUrl: string, extra: Record<string, string> = {}): Record<string, string> => ({
      PATH: process.env.PATH as string,
      ...autoHome.env,
      AGENT_HUB_CLI_JS: CLI_SOURCE,
      CLAUDE_PROJECT_DIR: autoHome.root,
      AGENT_HUB_URL: hubUrl,
      AGENT_HUB_DEV_USER: DEV_USER,
      AGENT_HUB_CLAUDE_PID: String(DEAD_PID),
      AGENT_HUB_AUTO_ENABLE: "true",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      ...extra
    });

    function registry(sid: string, fields: Record<string, unknown> = {}) {
      const pid = (fields.pid as number) ?? DEAD_PID;
      fs.writeFileSync(path.join(autoHome.claude, "sessions", `${sid}-${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd: autoHome.root, ...fields }));
    }

    const autoState = (sid: string, name: string) => path.join(autoHome.hub, sid, name);

    function runAuto(args: string[], { input = "", childEnv }: { input?: string; childEnv: Record<string, string> }): Promise<Run> {
      return new Promise((resolve) => {
        const child = spawn("bash", [BIN, ...args], { cwd: autoHome.root, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d) => {
          stdout += d;
        });
        child.stderr?.on("data", (d) => {
          stderr += d;
        });
        child.on("close", (status) => resolve({ status, stdout, stderr }));
        child.stdin?.end(input);
      });
    }

    beforeAll(async () => {
      autoHome = tempClaudeHome();
      autoHub = createMockHub({ pingMs: 200 });
      autoUrl = await autoHub.listen();
    });

    afterAll(async () => {
      await autoHub.close();
      autoHome.cleanup();
    });

    it("should auto-enable, opt out on disable and opt back in on enable, end to end", async () => {
      // Arrange
      const SESSION = "e2e-auto-sess";
      registry(SESSION, { kind: "interactive", name: "e2e-auto" });
      const childEnv = hookEnv(autoUrl);
      const registers = () => autoHub.calls.filter((c) => c.path === "/api/agent/register").length;

      // Act and assert
      const r = await runAuto(["hook", "SessionStart"], { input: JSON.stringify({ session_id: SESSION, source: "startup", cwd: autoHome.root }), childEnv });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
      await autoHub.waitFor((c) => c.path === "/api/agent/register" && c.body.session_id === SESSION, 20000);
      await waitUntil(() => fs.existsSync(autoState(SESSION, "enabled")), "the session to be enabled");
      await waitUntil(() => !fs.existsSync(autoState(SESSION, "auto-enable.lock")), "the auto-enable worker to finish");
      const spawned = /spawned bridge pid (\d+)/.exec(fs.readFileSync(autoState(SESSION, "log"), "utf8"));
      expect(spawned, "the auto-enable worker started a bridge").not.toBeNull();
      await waitUntil(() => exited(Number(spawned?.[1])), "the bridge to exit (its Claude pid is dead)", 20000);

      const d = await runAuto(["disable"], { childEnv: { ...childEnv, CLAUDE_CODE_SESSION_ID: SESSION } });
      expect(d.status, d.stderr).toBe(0);
      expect(fs.existsSync(autoState(SESSION, "opted-out"))).toBe(true);
      const before = registers();
      for (const source of ["resume", "startup"]) {
        const s = await runAuto(["hook", "SessionStart"], { input: JSON.stringify({ session_id: SESSION, source }), childEnv });
        expect(s.stdout).toBe("");
      }
      await runAuto(["hook", "UserPromptSubmit"], { input: JSON.stringify({ session_id: SESSION }), childEnv });
      await new Promise((r2) => setTimeout(r2, 300));
      expect(registers()).toBe(before);
      expect(fs.existsSync(autoState(SESSION, "enabled"))).toBe(false);

      const e = await runAuto(["enable"], { childEnv: { ...childEnv, CLAUDE_CODE_SESSION_ID: SESSION } });
      expect(e.status, e.stderr).toBe(0);
      expect(e.stdout).toMatch(/enabled as @/);
      expect(fs.existsSync(autoState(SESSION, "opted-out"))).toBe(false);
      expect(fs.existsSync(autoState(SESSION, "enabled"))).toBe(true);
      await waitUntil(() => exited(Number(/\(pid (\d+)\)/.exec(e.stdout)?.[1])), "the bridge to exit", 20000);
    });

    it("should keep the auto-enable worker alive when its hook is killed with its whole process tree", async () => {
      // Arrange
      const SESSION = "killed-hook-sess";
      registry(SESSION, { kind: "interactive", name: "killed-hook" });
      const childEnv = hookEnv(autoUrl);

      // Act: a hook that has started the worker and is still running, as a slow one is when its timeout hits.
      const code = `const { spawnDetached } = await import(${JSON.stringify(fileURLToPath(new URL("./session.ts", import.meta.url)))});
        await spawnDetached(${JSON.stringify(SESSION)}, ['auto-enable', '--session', ${JSON.stringify(SESSION)}], { env: process.env });
        process.stdout.write('spawned\\n');
        setTimeout(() => {}, 60000);`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: childEnv, detached: true, stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve, reject) => {
        child.stdout?.on("data", (d) => {
          if (String(d).includes("spawned")) {
            resolve();
          }
        });
        child.on("exit", (status) => reject(new Error(`the hook exited ${status} before it spawned the worker`)));
      });
      killTree(child.pid as number);

      // Assert
      await waitUntil(() => fs.existsSync(autoState(SESSION, "enabled")), "the session to be enabled", 20000);
      await waitUntil(() => !fs.existsSync(autoState(SESSION, "auto-enable.lock")), "the auto-enable worker to finish");
      const workerLog = fs.readFileSync(autoState(SESSION, "log"), "utf8");
      expect(workerLog).toMatch(/auto-enable: worker started/);
      expect(workerLog).toMatch(/enabled as killed-hook/);
      const bridge = /spawned bridge pid (\d+)/.exec(workerLog);
      await waitUntil(
        () => fs.readFileSync(autoState(SESSION, "log"), "utf8").includes("bridge started"),
        "the bridge, which needs the messaging token, to start"
      );
      await waitUntil(() => exited(Number(bridge?.[1])), "the bridge to exit (its Claude pid is dead)", 20000);
    });

    it("should say so in the session log when the auto-enable worker is terminated", async () => {
      // Arrange: a hub that accepts the connection and never answers, so the worker is still running.
      const silent = net.createServer(() => {});
      await new Promise<void>((r) => {
        silent.listen(0, "127.0.0.1", () => r());
      });
      const SESSION = "sigterm-sess";
      registry(SESSION, { kind: "interactive" });
      const childEnv = hookEnv(`http://127.0.0.1:${(silent.address() as net.AddressInfo).port}`);

      // Act
      try {
        const worker = spawn(process.execPath, [CLI_SOURCE, "auto-enable", "--session", SESSION], { env: childEnv, stdio: "ignore" });
        await waitUntil(() => fs.existsSync(autoState(SESSION, "auto-enable.lock")), "the worker to take its lock", 20000);
        worker.kill("SIGTERM");
        await new Promise((r) => worker.once("exit", r));

        // Assert
        expect(fs.readFileSync(autoState(SESSION, "log"), "utf8")).toMatch(/auto-enable: killed by SIGTERM/);
      } finally {
        silent.close();
      }
    });

    it("should refuse auto-enable, enable and the bridge without the messaging token", async () => {
      // Arrange
      const SESSION = "no-token-sess";
      registry(SESSION, { kind: "interactive" });
      const childEnv = hookEnv(autoUrl);
      delete childEnv.CLAUDE_CODE_MESSAGING_TOKEN;
      const registers = autoHub.calls.filter((c) => c.path === "/api/agent/register").length;

      // Act and assert
      const r = await runAuto(["hook", "SessionStart"], { input: JSON.stringify({ session_id: SESSION, source: "startup", cwd: autoHome.root }), childEnv });
      expect(r.status).toBe(0);
      await waitUntil(
        () => /auto-enable failed.*CLAUDE_CODE_MESSAGING_TOKEN is not set/.test(fs.readFileSync(autoState(SESSION, "log"), "utf8")),
        "the refusal to be logged",
        20000
      );

      const e = await runAuto(["enable"], { childEnv: { ...childEnv, CLAUDE_CODE_SESSION_ID: SESSION } });
      expect(e.status).toBe(1);
      expect(e.stderr).toMatch(/CLAUDE_CODE_MESSAGING_TOKEN is not set/);

      const b = await runAuto(["bridge", "--session", SESSION], { childEnv });
      expect(b.status).toBe(0);
      expect(fs.readFileSync(autoState(SESSION, "log"), "utf8")).toMatch(/bridge not started: CLAUDE_CODE_MESSAGING_TOKEN is not set/);
      expect(autoHub.calls.filter((c) => c.path === "/api/agent/register").length).toBe(registers);
      expect(fs.existsSync(autoState(SESSION, "enabled"))).toBe(false);
      expect(fs.existsSync(autoState(SESSION, "bridge.pid"))).toBe(false);
    });
  });
});

// What Claude Code does to a hook that outlives its timeout: its process group, and every descendant it can
// find, are killed.
function killTree(root: number): void {
  const children = new Map<number, number[]>();
  for (const line of execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number) as [number, number];
    if (!children.has(ppid)) {
      children.set(ppid, []);
    }
    children.get(ppid)?.push(pid);
  }
  const tree: number[] = [];
  for (const queue = [root]; queue.length; ) {
    const pid = queue.shift() as number;
    tree.push(pid);
    queue.push(...(children.get(pid) || []));
  }
  try {
    process.kill(-root, "SIGKILL");
  } catch {}
  for (const pid of tree) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
