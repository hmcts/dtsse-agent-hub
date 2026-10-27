// Guards on what npm ships and on the logic that exists twice in bash as well as TypeScript: `bin/agent-hub`
// repeats the virtual-agent predicate, because the fast-path gate must decide whether to start Node without
// starting Node, and `bin/virtual-agent-boot` repeats the one exit code it branches on. Nothing else can keep
// those copies in step.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { denyOutput, UNDELIVERED_REASON } from "./questions.ts";
import { EXIT_NO_CREDENTIAL } from "./virtual/phases.ts";
import { virtualAgent } from "./virtual-agent.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const BIN = path.join(PACKAGE_ROOT, "bin", "agent-hub");
const BOOT = path.join(PACKAGE_ROOT, "bin", "virtual-agent-boot");
const ENTRYPOINT = path.join(PACKAGE_ROOT, "virtual-agent", "entrypoint.sh");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

// `bin` is an object here, but `yarn install` rewrites it to a bare string whenever a package is left with one
// command named after itself, so read whichever shape the manifest is in.
function binTargets(manifest: { name: string; bin: string | Record<string, string> }): Record<string, string> {
  return typeof manifest.bin === "string" ? { [manifest.name.replace(/^@[^/]+\//, "")]: manifest.bin } : manifest.bin;
}

const ID = "0f8a6a1e-1234-4000-8000-000000000001";
const TOKEN = "lt-abc123";

let home: TempClaudeHome;
let recorders: string;

beforeAll(() => {
  home = tempClaudeHome();
  recorders = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-bin-"));
});

afterAll(() => {
  home.cleanup();
  fs.rmSync(recorders, { recursive: true, force: true });
});

// Stands in for the compiled CLI, so a run can be detected without the CLI existing yet.
function runGate(event: string, sid: string, env: Record<string, string>) {
  const marker = path.join(recorders, `${sid}.ran`);
  const cli = path.join(recorders, `${sid}.mjs`);
  fs.writeFileSync(cli, `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));\n`);
  const result = spawnSync("bash", [BIN, "hook", event], {
    input: JSON.stringify({ session_id: sid, source: "startup" }),
    encoding: "utf8",
    timeout: 20000,
    env: { PATH: process.env.PATH ?? "", ...home.env, AGENT_HUB_CLI_JS: cli, ...env }
  });
  return { status: result.status, stderr: result.stderr, ran: fs.existsSync(marker) };
}

describe("bin/agent-hub", () => {
  it("should be executable, since the hooks invoke it by path", () => {
    expect(fs.statSync(BIN).mode & 0o100).toBe(0o100);
  });

  it("should parse as bash", () => {
    const result = spawnSync("bash", ["-n", BIN], { encoding: "utf8", timeout: 20000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("should exit 0 for a hook with no session id, because a hook must never fail the session", () => {
    const result = runGate("SessionStart", "no-sid", {});
    expect(result.status).toBe(0);
  });

  it("should start the cli when auto-enable is on, so the gate is not simply inert", () => {
    expect(runGate("SessionStart", "auto-on", { AGENT_HUB_AUTO_ENABLE: "true" }).ran).toBe(true);
  });

  it("should not start the cli for a session that never enabled comms", () => {
    expect(runGate("SessionStart", "plain", {}).ran).toBe(false);
  });
});

// PATH alone does not find node outside an interactive shell: the devcontainer base installs nvm with
// PROFILE=/dev/null and sources it from .bashrc and .zshrc only, so every `kubectl exec` into a pod arrives
// without node and `bash -lc` does not help. Reading a pod's client version and reporting a stuck session both
// failed on that, so the command sources nvm.sh for itself — but only below the hook gate, which has to decide
// whether to start node without paying to start it.
describe("bin/agent-hub when node is not on PATH", () => {
  let root: string;
  let tools: string;
  let nodeDir: string;
  let cli: string;
  let bash: string;

  function which(tool: string): string {
    return spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-nvm-"));
    // Everything the script itself runs, and no node, so `command -v node` fails exactly as it does in a pod.
    tools = path.join(root, "tools");
    fs.mkdirSync(tools);
    for (const tool of ["bash", "dirname", "readlink", "cat"]) {
      fs.symlinkSync(which(tool), path.join(tools, tool));
    }
    bash = path.join(tools, "bash");
    // What sourcing a real nvm.sh does: prepend the directory holding node.
    nodeDir = path.join(root, "node-bin");
    fs.mkdirSync(nodeDir);
    fs.symlinkSync(process.execPath, path.join(nodeDir, "node"));
    cli = path.join(root, "cli.mjs");
    fs.writeFileSync(cli, 'console.log("cli ran");\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Writes the marker as well as putting node on PATH, so a caller can tell whether it was sourced at all.
  function fakeNvmHome(name: string, { nvm }: { nvm: boolean }): { home: string; marker: string } {
    const home = path.join(root, name);
    const marker = path.join(home, "sourced");
    fs.mkdirSync(home, { recursive: true });
    if (nvm) {
      fs.mkdirSync(path.join(home, ".nvm"), { recursive: true });
      fs.writeFileSync(path.join(home, ".nvm", "nvm.sh"), `: > ${JSON.stringify(marker)}\nexport PATH=${JSON.stringify(nodeDir)}:"$PATH"\n`);
    }
    return { home, marker };
  }

  it("should source nvm and reach the cli when node is only on nvm's path", () => {
    // Arrange
    const { home, marker } = fakeNvmHome("home-with-nvm", { nvm: true });

    // Act
    const result = spawnSync(bash, [BIN, "help"], { encoding: "utf8", timeout: 20000, env: { PATH: tools, HOME: home, AGENT_HUB_CLI_JS: cli } });

    // Assert
    expect(result.stderr).not.toContain("node is not on PATH");
    expect(result.stdout).toContain("cli ran");
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.status).toBe(0);
  });

  it("should say what to install when node is absent from PATH and from nvm", () => {
    // Arrange
    const { home } = fakeNvmHome("home-without-nvm", { nvm: false });

    // Act
    const result = spawnSync(bash, [BIN, "help"], { encoding: "utf8", timeout: 20000, env: { PATH: tools, HOME: home, AGENT_HUB_CLI_JS: cli } });

    // Assert
    expect(result.stderr).toContain("agent-hub: node is not on PATH. Install Node 22 or later");
    expect(result.stdout).not.toContain("cli ran");
    expect(result.status).toBe(1);
  });

  // `set -u` aborts on an expansion of an unset variable, so an unset HOME gave bash's "unbound variable" in
  // place of the error, for callers started with no shell in the way — which is the case this exists for.
  it("should still say what to install when HOME is not set either", () => {
    // Act
    const result = spawnSync(bash, [BIN, "help"], { encoding: "utf8", timeout: 20000, env: { PATH: tools, AGENT_HUB_CLI_JS: cli } });

    // Assert
    expect(result.stderr).not.toMatch(/unbound variable/);
    expect(result.stderr).toContain("agent-hub: node is not on PATH. Install Node 22 or later");
    expect(result.status).toBe(1);
  });

  // UserPromptContext runs the gate synchronously on every prompt, so the cost of sourcing nvm has to stay out
  // of the path a session that never enabled comms takes. The marker is the only thing that can prove it did not.
  it("should not source nvm when the hook gate takes its fast path", () => {
    // Arrange
    const { home, marker } = fakeNvmHome("home-fast-path", { nvm: true });

    // Act
    const result = spawnSync(bash, [BIN, "hook", "SessionStart"], {
      input: JSON.stringify({ session_id: "fast-path", source: "startup" }),
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: tools, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), AGENT_HUB_CLI_JS: cli }
    });

    // Assert
    expect(fs.existsSync(marker)).toBe(false);
    expect(result.stdout).not.toContain("cli ran");
    expect(result.status).toBe(0);
  });
});

// npm installs a bin as a symlink from <prefix>/bin, so the directory the hooks invoke has no dist/ beside it.
// A gate that resolved its own path without following the chain found no CLI, and the hook path swallows the
// failure, which turns every hook into a silent no-op. `AGENT_HUB_CLI_JS` is never set here: it would override
// the very path under test. A packed install is the real shape of this, and `npm pack` needs `dist/` built, so
// the layout is assembled here instead and the published tarball is proved by the release workflow.
describe("bin/agent-hub reached through a symlink", () => {
  let installed: string;
  let sandbox: string;
  let via: { relative: string; absolute: string; chained: string };

  beforeAll(() => {
    installed = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-link-"));
    fs.mkdirSync(path.join(installed, "pkg", "bin"), { recursive: true });
    fs.mkdirSync(path.join(installed, "pkg", "dist"), { recursive: true });
    fs.mkdirSync(path.join(installed, "prefix", "bin"), { recursive: true });
    fs.mkdirSync(path.join(installed, "prefix", "nested"), { recursive: true });
    fs.copyFileSync(BIN, path.join(installed, "pkg", "bin", "agent-hub"));
    fs.chmodSync(path.join(installed, "pkg", "bin", "agent-hub"), 0o755);
    // Stands in for the compiled CLI, which the suite does not build; it prints what the gate handed it.
    fs.writeFileSync(
      path.join(installed, "pkg", "dist", "cli.js"),
      "console.log(JSON.stringify({ args: process.argv.slice(2), invokedAs: process.env.AGENT_HUB_INVOKED_AS }));\n"
    );
    via = {
      relative: path.join(installed, "prefix", "bin", "agent-hub"),
      absolute: path.join(installed, "prefix", "bin", "agent-hub-absolute"),
      chained: path.join(installed, "prefix", "nested", "agent-hub")
    };
    fs.symlinkSync(path.join("..", "..", "pkg", "bin", "agent-hub"), via.relative);
    fs.symlinkSync(path.join(installed, "pkg", "bin", "agent-hub"), via.absolute);
    fs.symlinkSync(path.join("..", "bin", "agent-hub"), via.chained);
    // A PATH holding everything the gate itself runs and no agent-hub, so that the bare name resolves to
    // nothing here exactly as it does on a workstation whose only agent-hub is cft-workspace's shim. The
    // runner's own PATH cannot say that: a global install, or yarn's node_modules/.bin, would be on it.
    sandbox = path.join(installed, "sandbox-bin");
    fs.mkdirSync(sandbox);
    fs.symlinkSync(process.execPath, path.join(sandbox, "node"));
    for (const tool of ["bash", "dirname", "readlink"]) {
      fs.symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), path.join(sandbox, tool));
    }
  });

  afterAll(() => {
    fs.rmSync(installed, { recursive: true, force: true });
  });

  // The stub CLI's one line of output: no AGENT_HUB_CLI_JS, so the path under test is the one the gate worked out.
  function run(bin: string, args: string[], { input = "", env = {} }: { input?: string; env?: Record<string, string> } = {}) {
    const { AGENT_HUB_CLI_JS: _ignored, ...rest } = process.env;
    const result = spawnSync(bin, args, { input, encoding: "utf8", timeout: 20000, env: { ...rest, ...home.env, ...env } });
    return { ...result, cli: result.stdout.trim() ? (JSON.parse(result.stdout) as { args: string[]; invokedAs?: string }) : null };
  }

  it.each(["relative", "absolute", "chained"] as const)("should find the cli beside the package through a %s symlink", (kind) => {
    // Act
    const result = run(via[kind], ["help"]);

    // Assert
    expect(result.stderr).toBe("");
    expect(result.cli?.args).toEqual(["help"]);
    expect(result.status).toBe(0);
  });

  it("should run the cli for a hook that has a held note, rather than silently doing nothing", () => {
    // Arrange
    const dir = path.join(home.hub, "linked-sid");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "enabled"), "yes\n");
    fs.writeFileSync(path.join(dir, "held-notes.jsonl"), '{"note":"x"}\n');

    // Act
    const result = run(via.relative, ["hook", "UserPromptContext"], { input: '{"session_id":"linked-sid"}' });

    // Assert
    expect(result.cli?.args).toEqual(["hook", "UserPromptContext"]);
    expect(result.status).toBe(0);
  });

  // Every hint the CLI prints quotes a command the reader is told to run, so it has to be one the machine has.
  // The bare name is the right spelling for a global install and the wrong one everywhere else: a workstation
  // whose only agent-hub is cft-workspace's `scripts/agent-hub` shim was told to run `agent-hub reply …`.
  it("should pass on the bare name when it was invoked as a command on PATH", () => {
    // Arrange
    const env = { PATH: `${path.dirname(via.absolute)}:${sandbox}` };

    // Act
    const result = run(via.absolute, ["help"], { env });

    // Assert
    expect(result.cli?.invokedAs).toBe("agent-hub-absolute");
  });

  it("should pass on the whole path when it was invoked by one and the bare name is not installed", () => {
    // Act
    const result = run(via.chained, ["help"], { env: { PATH: sandbox } });

    // Assert
    expect(result.cli?.invokedAs).toBe(via.chained);
  });

  it("should keep the name a wrapper set when it set one itself", () => {
    // Act
    const result = run(via.relative, ["help"], { env: { PATH: sandbox, AGENT_HUB_INVOKED_AS: "scripts/agent-hub" } });

    // Assert
    expect(result.cli?.invokedAs).toBe("scripts/agent-hub");
  });
});

describe("bin/virtual-agent-boot", () => {
  it("should be executable, since a pod's command is this script", () => {
    expect(fs.statSync(BOOT).mode & 0o100).toBe(0o100);
  });

  it("should parse as bash", () => {
    const result = spawnSync("bash", ["-n", BOOT], { encoding: "utf8", timeout: 20000 });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  // The script tells "the owner did not complete the sign-in" from every other failure by this code alone: it
  // waits for a pasted token on this one and retries the rest. Its bash copy drifting would make it retry the
  // outcome the bound exists to stop, or wait for ever on a hub it should have ridden out.
  it("should hold its copy of EXIT_NO_CREDENTIAL in step with the client's", () => {
    // Act & Assert
    expect(fs.readFileSync(BOOT, "utf8")).toContain(`\nEXIT_NO_CREDENTIAL=${EXIT_NO_CREDENTIAL}\n`);
  });

  // Under `set -u` an expansion of an unset variable aborts before any `:?` further down can explain itself, so
  // the owner of a misconfigured pod got bash's "unbound variable" instead of the name they had to set.
  const missing: { name: string; env: Record<string, string> }[] = [
    { name: "AGENT_HUB_URL", env: {} },
    { name: "AGENT_HUB_VIRTUAL_AGENT_ID", env: { AGENT_HUB_URL: "https://hub.example" } },
    { name: "AGENT_HUB_LAUNCH_TOKEN", env: { AGENT_HUB_URL: "https://hub.example", AGENT_HUB_VIRTUAL_AGENT_ID: "va-1" } }
  ];

  // Boot execs this and nothing else does, so an entrypoint that lost its execute bit fails the agent at the
  // handover with no stage 1 at all.
  it("should exec a runtime that is executable and parses as bash", () => {
    // Act
    const result = spawnSync("bash", ["-n", ENTRYPOINT], { encoding: "utf8", timeout: 20000 });

    // Assert
    expect(fs.statSync(ENTRYPOINT).mode & 0o100).toBe(0o100);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(missing)("should say $name is not set when it is the first one missing", ({ name, env }) => {
    // Act
    const result = spawnSync("bash", [BOOT], { encoding: "utf8", timeout: 20000, env: { PATH: process.env.PATH ?? "", ...env } });

    // Assert
    expect(result.stderr).not.toMatch(/unbound variable/);
    expect(result.stderr).toContain(`${name} is not set`);
    expect(result.status).not.toBe(0);
  });
});

/**
 * The gate's own answer to a `PreToolUse` it cannot hand to the CLI. A hook that prints nothing is read as "no
 * decision", so `AskUserQuestion`'s prompt is drawn and a pod's session waits for a keyboard nobody is at — which
 * is the one thing this hook exists to prevent, and the one failure that used to reach it: a missing `dist/`, a
 * node that is not installed, a crash and an OOM kill all land on this path. The CLI stands in for each of them,
 * because the gate's rule is "the CLI did not print a decision" whatever the cause.
 */
describe("bin/agent-hub answering a PreToolUse it cannot hand to the cli", () => {
  const POD = { AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: TOKEN };
  const CONVERSATION = { AGENT_HUB_CONVERSATION_ID: "0f8a6a1e-1234-4000-8000-0000000000bb" };
  const ASK = { session_id: ID, hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_1" };

  /** Runs the gate with a stand-in CLI: `cli` is the JavaScript it runs, or `null` for a CLI that is not there. */
  function runPreToolUse(name: string, cli: string | null, env: Record<string, string>, input: unknown = ASK) {
    const js = path.join(recorders, `${name}.mjs`);
    if (cli === null) {
      fs.rmSync(js, { force: true });
    } else {
      fs.writeFileSync(js, cli);
    }
    const result = spawnSync("bash", [BIN, "hook", "PreToolUse"], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: 20000,
      env: { PATH: process.env.PATH ?? "", ...home.env, AGENT_HUB_CLI_JS: js, ...env }
    });
    return { status: result.status, decision: result.stdout.trim() === "" ? null : (JSON.parse(result.stdout) as Record<string, any>) };
  }

  const denied = (reason?: string) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", ...(reason === undefined ? {} : { permissionDecisionReason: reason }) }
  });

  it.each([
    ["the cli is not installed at all", null],
    ["the cli printed nothing", "process.exit(0)\n"],
    ["the cli crashed", 'throw new Error("boom")\n'],
    ["the cli was killed", "process.kill(process.pid, 'SIGKILL')\n"]
  ])("should deny the question itself when %s", (label, cli) => {
    // Act
    const result = runPreToolUse(`deny-${label.replace(/[^a-z]+/g, "-")}`, cli, POD);

    // Assert
    expect(result.decision).toMatchObject(denied(UNDELIVERED_REASON));
    expect(result.status).toBe(0);
  });

  it("should deny for an Assistant conversation as well as a pod, since neither has anyone at a keyboard", () => {
    expect(runPreToolUse("deny-conversation", null, CONVERSATION).decision).toMatchObject(denied(UNDELIVERED_REASON));
  });

  // A broken payload is still a question: the hook is registered for that one tool, so a body naming no tool is a
  // payload the gate could not read rather than some other tool's call.
  it("should deny when the payload names no tool at all", () => {
    expect(runPreToolUse("deny-nameless", null, POD, { session_id: ID }).decision).toMatchObject(denied(UNDELIVERED_REASON));
  });

  it("should pass the cli's own decision through untouched when it managed to make one", () => {
    // Arrange
    const reason = "the cli decided this";
    const cli = `console.log(${JSON.stringify(JSON.stringify(denyOutput(reason)))})\n`;

    // Act
    const result = runPreToolUse("deny-from-cli", cli, POD);

    // Assert
    expect(result.decision).toEqual(denyOutput(reason));
  });

  // The other half of the rule: a person at the keyboard can answer the prompt, so taking the tool away from them
  // would be the regression, and another tool's call is none of this hook's business.
  it.each([
    ["an engineer's own session", {}, ASK],
    ["another tool in a pod", POD, { session_id: ID, tool_name: "Bash", tool_input: { command: "grep AskUserQuestion ." } }]
  ])("should decide nothing for %s", (label, env, input) => {
    // Act
    const result = runPreToolUse(`allow-${label.replace(/[^a-z]+/g, "-")}`, null, env, input);

    // Assert
    expect(result.decision).toBeNull();
    expect(result.status).toBe(0);
  });

  // The gate cannot call `denyOutput`, so it carries the JSON written out by hand. Nothing else would notice the
  // two drifting: the gate would go on printing a decision Claude Code accepts, saying something the client no
  // longer says, and only on the path nobody exercises by hand.
  it("should hold its copy of the undelivered deny in step with the client's", () => {
    expect(fs.readFileSync(BIN, "utf8")).toContain(`deny='${JSON.stringify(denyOutput(UNDELIVERED_REASON))}'`);
  });
});

describe("the bash gate's virtual-agent predicate", () => {
  const matrix: { name: string; env: Record<string, string> }[] = [
    { name: "no pod environment at all", env: {} },
    { name: "both the id and the launch token", env: { AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: TOKEN } },
    { name: "only the id", env: { AGENT_HUB_VIRTUAL_AGENT_ID: ID } },
    { name: "only the launch token", env: { AGENT_HUB_LAUNCH_TOKEN: TOKEN } },
    { name: "an empty id beside a real launch token", env: { AGENT_HUB_VIRTUAL_AGENT_ID: "", AGENT_HUB_LAUNCH_TOKEN: TOKEN } },
    { name: "a real id beside an empty launch token", env: { AGENT_HUB_VIRTUAL_AGENT_ID: ID, AGENT_HUB_LAUNCH_TOKEN: "" } },
    { name: "both empty", env: { AGENT_HUB_VIRTUAL_AGENT_ID: "", AGENT_HUB_LAUNCH_TOKEN: "" } },
    { name: "the retired AGENT_HUB_VIRTUAL flag on its own", env: { AGENT_HUB_VIRTUAL: "1" } }
  ];

  it.each(matrix)("should agree with virtualAgent() given $name", ({ name, env }) => {
    const sid = `matrix-${name.replace(/[^a-z0-9]+/g, "-")}`;
    expect(runGate("SessionStart", sid, env).ran).toBe(virtualAgent(env) !== null);
  });
});

describe("the published tarball", () => {
  it("should install the agent-hub and virtual-agent-boot commands", () => {
    expect(binTargets(MANIFEST)).toMatchObject({ "agent-hub": "bin/agent-hub", "virtual-agent-boot": "bin/virtual-agent-boot" });
  });

  it("should ship every bin target", () => {
    const files: string[] = MANIFEST.files;
    for (const target of Object.values(binTargets(MANIFEST))) {
      expect(fs.existsSync(path.join(PACKAGE_ROOT, target))).toBe(true);
      expect(files).toContain(target.split("/")[0]);
    }
  });

  it("should ship the secret patterns the scanner reads at runtime", () => {
    expect(MANIFEST.files).toContain("secret-patterns");
    expect(fs.existsSync(path.join(PACKAGE_ROOT, "secret-patterns"))).toBe(true);
  });

  // A pod execs the runtime out of the installed package and the supervisor hands hai the prompt beside it, so a
  // tarball without them boots nothing.
  it("should ship the pod runtime and the prompt the supervisor appends", () => {
    expect(MANIFEST.files).toContain("virtual-agent");
    expect(fs.existsSync(ENTRYPOINT)).toBe(true);
    expect(fs.existsSync(path.join(PACKAGE_ROOT, "virtual-agent", "assistant-prompt.md"))).toBe(true);
  });

  it("should ship whatever its exports point at", () => {
    const targets = Object.values(MANIFEST.exports).flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry as Record<string, string>)));
    for (const target of targets) {
      const first = target.replace(/^\.\//, "").split("/")[0] as string;
      expect(first === "package.json" || MANIFEST.files.includes(first)).toBe(true);
    }
  });

  it("should declare no runtime dependencies, because the gate must not pay module-load cost", () => {
    expect(MANIFEST.dependencies).toBeUndefined();
    expect(MANIFEST.optionalDependencies).toBeUndefined();
    expect(MANIFEST.peerDependencies).toBeUndefined();
  });

  // Every install of this package passes --ignore-scripts, on the grounds that it declares none and
  // has no dependency that could. A dependency with a postinstall would otherwise be installed
  // unbuilt, in a pod and in an image, and fail at runtime with nothing said at build time.
  it("should declare no install lifecycle script, because every install of it skips scripts", () => {
    for (const name of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepack"]) {
      expect(Object.keys((MANIFEST.scripts ?? {}) as Record<string, string>)).not.toContain(name);
    }
  });
});
