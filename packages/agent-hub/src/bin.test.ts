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
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));

// `yarn install` normalises a lone `bin` entry whose name matches the package's to a bare string, so resolve it
// back to the command names npm will link.
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
  it("should install a command called agent-hub", () => {
    expect(binTargets(MANIFEST)).toMatchObject({ "agent-hub": "bin/agent-hub" });
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
