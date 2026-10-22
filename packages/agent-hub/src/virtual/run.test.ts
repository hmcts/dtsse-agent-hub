// `agent-hub virtual <command>`, driven in process. The workspace suite ran these through the bash bin as a
// child process; what is asserted here is the exit code each command resolves to and what it wrote. The
// child-process half — that the bin forwards argv and exits with this code — is in `cli.test.ts`, which runs
// `virtual watch-ports` through `bin/agent-hub` and checks its exit code and stderr.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "../__fixtures__/mock-hub.ts";
import { captureStderr, createPodShims, type PodShims, podSecrets, usePodEnv } from "../__fixtures__/pod-shims.ts";
import { createApi } from "../api.ts";
import { EXIT_FATAL, EXIT_NO_CREDENTIAL } from "./phases.ts";
import { runVirtual, VIRTUAL_USAGE } from "./run.ts";
import { run } from "./sign-in.ts";

const PROC_NET = fileURLToPath(new URL("../__fixtures__/proc-net", import.meta.url));
const VID = "va-run";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
const LAUNCH = podSecrets.launchToken;
const CLAUDE_TOKEN = podSecrets.claudeToken;

let hub: MockHub;
let url: string;
let pod: PodShims;
let restoreEnv: () => void;

beforeAll(async () => {
  hub = createMockHub({ pingMs: 5000, launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
  url = await hub.listen();
  pod = createPodShims({ virtualId: VID, hubUrl: url });
  restoreEnv = usePodEnv(pod.home);
});

afterEach(() => {
  const v = virtual();
  v.status.length = 0;
  v.prompts.length = 0;
  v.completes.length = 0;
  v.credentials.clear();
  v.codes.clear();
  v.ports.length = 0;
  pod.reset();
});

afterAll(async () => {
  await hub.close();
  restoreEnv();
  pod.cleanup();
});

const virtual = () => hub.virtuals.get(VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;
const api = () => createApi({ baseUrl: url, launchToken: LAUNCH });

type Invocation = { code: number; stdout: string; stderr: string; printed: string[] };

/** Runs one virtual command and collects its exit code, stdout, stderr and anything it printed as usage. */
async function virtualCommand(args: string[], { env = pod.env(), input = "" }: { env?: Record<string, string>; input?: string } = {}): Promise<Invocation> {
  let stdout = "";
  const printed: string[] = [];
  const { result, stderr } = await captureStderr(() =>
    runVirtual(args, {
      api: api(),
      env,
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        }
      },
      readStdin: () => input,
      log: (message) => printed.push(message)
    })
  );
  return { code: result, stdout, stderr, printed };
}

describe("runVirtual status", () => {
  it("should report the phase with no detail when given only a phase", async () => {
    // Act
    const r = await virtualCommand(["status", "running"]);

    // Assert
    expect(r.code).toBe(0);
    expect(virtual().status.at(-1)).toEqual({ phase: "running" });
  });

  it("should join the remaining words into the detail when given one", async () => {
    // Act
    const r = await virtualCommand(["status", "cloning", "the", "workspace", "repositories"]);

    // Assert
    expect(r.code).toBe(0);
    expect(virtual().status.at(-1)).toEqual({ phase: "cloning", detail: "the workspace repositories" });
  });

  it("should exit 1 and name the phases when given something that is not one", async () => {
    // Act
    const r = await virtualCommand(["status", "dancing"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/phase must be one of provisioning, awaiting_credentials, awaiting_login, cloning, running, failed/);
  });
});

describe("runVirtual credential", () => {
  it("should take the value from stdin, print it back on stdout and exit 4 while none is stored", async () => {
    // Act
    const missing = await virtualCommand(["credential", "get", "claude"]);
    const put = await virtualCommand(["credential", "put", "claude"], { input: `${CLAUDE_TOKEN}\n` });
    const got = await virtualCommand(["credential", "get", "claude"]);

    // Assert
    expect(missing.code).toBe(EXIT_NO_CREDENTIAL);
    expect(missing.stdout).toBe("");
    expect(put.code).toBe(0);
    expect(got.code).toBe(0);
    expect(got.stdout).toBe(CLAUDE_TOKEN);
    for (const r of [missing, put, got]) {
      expect(r.stderr).not.toContain(CLAUDE_TOKEN);
      expect(r.stderr).not.toContain(LAUNCH);
    }
  });

  it("should exit 1 with the reason when stdin is empty", async () => {
    // Act
    const r = await virtualCommand(["credential", "put", "claude"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/credential put reads the value from stdin, and it was empty/);
  });
});

describe("runVirtual azure-login", () => {
  it("should exit 3 and say why when the hub refuses the account as not the owner", async () => {
    // Act
    const r = await virtualCommand(["azure-login"], { env: pod.env({ SHIM_OID: "oid-intruder" }) });

    // Assert
    expect(r.code).toBe(EXIT_FATAL);
    expect(r.stderr).toMatch(/not the agent owner/);
  });
});

describe("runVirtual atlassian-login", () => {
  it("should exit 4, never fatally, when the owner lets the device code expire", async () => {
    // Act
    const r = await virtualCommand(["atlassian-login"], { env: pod.env({ FAKE_TWG_LOGIN: "expire" }) });

    // Assert
    expect(r.code).toBe(EXIT_NO_CREDENTIAL);
    expect(r.stderr).toMatch(/sign-in was not completed .*Jira and Confluence stay signed out/);
    expect(virtual().prompts).toHaveLength(1);
    expect(virtual().credentials.has("atlassian")).toBe(false);
    expect(virtual().completes).toEqual([]);
  });

  it("should exit 1 and leave the agent unfailed when twg prints no code at all", async () => {
    // Act
    const r = await virtualCommand(["atlassian-login"], { env: pod.env({ FAKE_TWG_LOGIN: "crash" }) });

    // Assert
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/printed no sign-in code/);
    expect(virtual().status.some((s) => s.phase === "failed")).toBe(false);
  });
});

describe("runVirtual github-login and claude-login", () => {
  it("should relay a GitHub sign-in and exit 0", async () => {
    // Act
    const r = await virtualCommand(["github-login"], { env: pod.env({ FAKE_GH_TOKEN: podSecrets.githubToken }) });

    // Assert
    expect(r.code).toBe(0);
    expect(virtual().credentials.get("github")).toBe(podSecrets.githubToken);
  });

  it("should relay a Claude sign-in and exit 0", async () => {
    // Arrange
    virtual().codes.set("claude", "good-code#state");

    // Act
    const r = await virtualCommand(["claude-login"], { env: pod.env({ FAKE_CLAUDE_TOKEN: CLAUDE_TOKEN }) });

    // Assert
    expect(r.code).toBe(0);
    expect(virtual().credentials.get("claude")).toBe(CLAUDE_TOKEN);
    expect(r.stderr).not.toContain(CLAUDE_TOKEN);
  });
});

describe("runVirtual git-identity", () => {
  it("should set the global git identity from gh and az, and then from the owner's override", async () => {
    // Arrange
    const gitHome = path.join(pod.home.root, "git-home");
    fs.mkdirSync(gitHome, { recursive: true });
    const env = pod.env({
      HOME: gitHome,
      GIT_CONFIG_NOSYSTEM: "1",
      FAKE_GH_USER: JSON.stringify({ login: "octocat", id: 583231, name: "The Octocat", email: null }),
      FAKE_GH_EMAILS: JSON.stringify([{ email: "olive@hmcts.net", verified: true }])
    });
    const get = async (key: string) => (await run("git", ["config", "--global", "--get", key], { env })).stdout.trim();

    // Act
    const first = await virtualCommand(["git-identity"], { env });

    // Assert
    expect(first.code).toBe(0);
    expect(await get("user.name")).toBe("The Octocat");
    expect(await get("user.email")).toBe("olive@hmcts.net");
    expect(await get("push.autoSetupRemote")).toBe("true");
    expect(await get("init.defaultBranch")).toBe("master");
    expect(first.stderr).toMatch(/git: user\.email olive@hmcts\.net \(HMCTS email, verified on the GitHub account\)/);
    expect(first.stderr).not.toContain(LAUNCH);

    // Act: the owner's stored override wins over what GitHub says.
    virtual().credentials.set("git_identity", JSON.stringify({ email: "olive@example.com" }));
    const again = await virtualCommand(["git-identity"], { env });

    // Assert
    expect(again.code).toBe(0);
    expect(await get("user.email")).toBe("olive@example.com");
    expect(await get("user.name")).toBe("The Octocat");
  });
});

describe("runVirtual watch-ports", () => {
  it("should report the ports once and exit 0 on SIGTERM", async () => {
    // Arrange
    const env = pod.env({ AGENT_HUB_PROC_NET: PROC_NET, AGENT_HUB_PORTS_MS: "20", VIRTUAL_AGENT_IGNORE_PORTS: "4000" });

    // Act
    const { result, stderr } = await captureStderr(async () => {
      const running = runVirtual(["watch-ports"], { api: api(), env });
      const deadline = Date.now() + 10000;
      while (virtual().ports.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 200));
      process.emit("SIGTERM");
      return running;
    });

    // Assert: one report, not one per read.
    expect(result).toBe(0);
    expect(virtual().ports).toEqual([{ ports: [3000, 8080], local_only: [5173, 8081, 9090] }]);
    expect(stderr).toMatch(/ports: reported 3000, 8080; on 127\.0\.0\.1 only: 5173, 8081, 9090/);
  });
});

describe("runVirtual cache-sync", () => {
  it("should store nothing and exit 0 when --once finds neither sign-in", async () => {
    // Act
    const r = await virtualCommand(["cache-sync", "--once"]);

    // Assert
    expect(r.code).toBe(0);
    expect(virtual().credentials.size).toBe(0);
  });
});

describe("runVirtual help", () => {
  it("should print the usage and exit 0 when given help or nothing", async () => {
    // Act
    const help = await virtualCommand(["help"]);
    const nothing = await virtualCommand([]);

    // Assert
    expect(help.code).toBe(0);
    expect(help.printed).toEqual([VIRTUAL_USAGE]);
    expect(nothing.printed).toEqual([VIRTUAL_USAGE]);
    expect(VIRTUAL_USAGE).toContain("usage: scripts/agent-hub virtual <command>");
    expect(VIRTUAL_USAGE).toContain("Kinds: github, azure, claude, bedrock, jenkins, atlassian, claude_md, git_identity.");
  });

  it("should exit 1 with the usage when the command is not one of them", async () => {
    // Act
    const r = await virtualCommand(["dance"]);

    // Assert
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown virtual command: dance");
    expect(r.stderr).toContain("usage: scripts/agent-hub virtual <command>");
  });
});

describe("runVirtual outside a pod", () => {
  it("should exit 1 with the original message when the environment is not a virtual agent's", async () => {
    // Act
    const noId = await virtualCommand(["status", "running"], { env: { AGENT_HUB_URL: url, AGENT_HUB_LAUNCH_TOKEN: LAUNCH } });
    const noToken = await virtualCommand(["status", "running"], { env: { AGENT_HUB_URL: url, AGENT_HUB_VIRTUAL_AGENT_ID: VID } });

    // Assert
    expect(noId.code).toBe(1);
    expect(noId.stderr).toContain("AGENT_HUB_VIRTUAL_AGENT_ID is not set; this only runs in a virtual agent pod");
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain("AGENT_HUB_LAUNCH_TOKEN is not set");
  });
});
