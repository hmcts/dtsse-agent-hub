// `test/entrypoint.test.sh` drives `virtual-agent/entrypoint.sh` — stage 1 of a virtual agent's pod — against
// fake tmux, hai, claude, npm, an agent-hub client and a workspace. Only the case list can be owned from here:
// the script is bash, so what it asserts stays in bash and this reads its `ok <name>` / `FAIL <name>: …` lines.
//
// No mock hub: every call the runtime makes to the hub goes through the agent-hub client, which the script
// fakes, and the suite must also run under the `bash:3.2` image, which has no node to run a real one with.
//
// One run of the script per case, as the boot suite does, because each case boots a pod of its own. Several
// cases wait out the hai install's backoff, so the timeout is generous.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = "test/entrypoint.test.sh";
// hai-install-falls-back spends three of retry()'s delays — 30s then 60s — before it accepts the image's hai.
const CASE_TIMEOUT = 300_000;

// The cases the script holds, named here so a failure names the case; "should drive every case the script has"
// keeps the two lists in step.
const CASES = [
  "first-boot",
  "bedrock-route",
  "legacy-gateway-route",
  "unknown-route",
  "hai-install-blip-recovers",
  "hai-install-falls-back",
  "hai-installed-off-path",
  "hai-install-retries",
  "hai-install-keeps-failing",
  "hai-install-leaves-no-binary",
  "continues-a-conversation",
  "git-identity-fails",
  "later-boot-fails",
  "sigterm-mid-clone",
  "claude-md-stored",
  "claude-md-missing",
  "claude-md-error",
  "claude-md-restart",
  "atlassian-fails",
  "atlassian-not-signed-in",
  "atlassian-sigterm",
  "atlassian-no-twg",
  "azure-restored",
  "azure-not-stored",
  "azure-requested",
  "azure-request-fails",
  "azure-wrong-account",
  "azure-sigterm",
  "conversations",
  "prepare-workspace",
  "prepare-workspace-fails",
  "prepare-workspace-dies",
  "prepare-workspace-dies-silently",
  "prepare-workspace-sigterm",
  "no-clone-step",
  "client-on-path",
  "broken-workspace-shim"
];

type Run = {
  out: string;
  code: number | null;
  oks: string[];
  fails: string[];
  skips: string[];
  summary: { passed: number; failed: number } | null;
};

// The script's last line. A script that dies part way through prints no summary, and one that is cut short
// prints a count that disagrees with the `ok` lines; neither may pass as success.
function summarise(out: string): { passed: number; failed: number } | null {
  const m = /^(\d+) passed, (\d+) failed$/m.exec(out);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

// The hub runs in no process here, but the script still has to be spawned asynchronously: `spawnSync` would
// block the event loop for the whole of a case, and vitest's own timeout would never fire.
function runCase(name: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, name], { cwd: PACKAGE_ROOT, env: process.env });
    let out = "";
    const collect = (chunk: Buffer) => {
      out += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
      const lines = out.split("\n");
      resolve({
        out,
        code,
        oks: lines.filter((l) => l.startsWith("ok ")),
        fails: lines.filter((l) => l.startsWith("FAIL ")),
        skips: lines.filter((l) => l.startsWith("skip ")),
        summary: summarise(out)
      });
    });
  });
}

describe("test/entrypoint.test.sh", () => {
  it("should drive every case the script has", () => {
    // Act
    const result = spawnSync("bash", [SCRIPT, "--list"], { cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 20000 });

    // Assert
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(CASES);
  });

  it.each(CASES)(
    "should pass every assertion when the pod boots in the %s case",
    async (name) => {
      // Act
      const run = await runCase(name);

      // Assert: a case the host cannot arrange says so and asserts nothing; anything else has to assert.
      expect(run.fails, run.out).toEqual([]);
      if (run.skips.length === 0) {
        expect(run.oks.length, run.out).toBeGreaterThan(0);
      }
      expect(run.summary, run.out).toEqual({ passed: run.oks.length, failed: 0 });
      expect(run.code, run.out).toBe(0);
    },
    CASE_TIMEOUT
  );
});
