// Guards on what npm ships and on the one piece of logic that exists twice: `bin/agent-hub` repeats the
// virtual-agent predicate in bash, because the fast-path gate must decide whether to start Node without
// starting Node. Nothing else can keep the two copies in step.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
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
  });
});
