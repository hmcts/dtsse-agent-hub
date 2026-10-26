// `test/boot.test.sh` drives `bin/virtual-agent-boot` — stage 0 of a virtual agent's pod — against fake gh,
// git, npm and sleep, the package's own client, and a mock hub. Only the hub can be owned from here: the script
// is bash, so what it asserts stays in bash and this reads its `ok <name>` / `FAIL <name>: …` lines.
//
// One hub per case, and one run of the script per case: every case reads a virtual agent whose status,
// prompts and completes start empty, which the script used to get by restarting the mock hub between cases.
// The hub runs in this process, so the script is spawned asynchronously — `spawnSync` would block the event
// loop and the hub would never answer.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub } from "./__fixtures__/mock-hub.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = "test/boot.test.sh";
const VID = "va-boot-1";
const LAUNCH = "launch-boot-test";
const OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
// Each case boots once, and a hung boot is killed by the script's own 30s watchdog.
const CASE_TIMEOUT = 120_000;

// The cases the script holds, named here so a failure names the case; "should drive every case the script
// has" keeps the two lists in step.
const CASES = [
  "no-token",
  "refused-token",
  "sign-in-not-completed",
  "stored-token-no-access",
  "checkout-client",
  "broken-checkout-client",
  "no-client",
  "trailing-slash",
  "client-upgrade",
  "client-upgrade-offline",
  "client-upgrade-no-npm",
  "client-upgrade-pinned",
  "package-entrypoint",
  "client-upgrade-ships-entrypoint",
  "checkout-entrypoint"
];

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-boot-"));
});

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

type Run = { out: string; code: number | null; oks: string[]; fails: string[]; summary: { passed: number; failed: number } | null };

// The script's last line. A script that dies part way through prints no summary, and one that is cut short
// prints a count that disagrees with the `ok` lines; neither may pass as success.
function summarise(out: string): { passed: number; failed: number } | null {
  const m = /^(\d+) passed, (\d+) failed$/m.exec(out);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : null;
}

function runScript(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT, ...args], { cwd: PACKAGE_ROOT, env: { ...process.env, ...env } });
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
        summary: summarise(out)
      });
    });
  });
}

// The mock hub, and the state file the script's jq assertions read: what the virtual agent has been told,
// rewritten as each of the hub's responses goes out, as the script's own mock-hub process used to write it.
//
// It goes to a temp file in the same directory and is renamed over the state, so a read is either the whole
// previous state or the whole new one: writing the path itself truncates it first, and a jq that reads the
// empty file answers with an empty value and exit 0, which an assertion cannot tell apart from a phase the
// pod never reported. And it is written as the response goes out rather than on that response's `finish`,
// which is emitted only after the data has reached the socket — late enough for the script to be asserting
// on a state a request behind.
async function runCase(name: string): Promise<Run> {
  const hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: OWNER } } });
  const url = await hub.listen();
  const state = path.join(stateDir, `${name}.json`);
  const v = hub.virtuals.get(VID)!;
  const dump = () => {
    fs.writeFileSync(
      `${state}.tmp`,
      JSON.stringify({
        status: v.status,
        prompts: v.prompts,
        completes: v.completes,
        loginFailures: v.loginFailures,
        github: v.credentials.get("github") ?? null
      })
    );
    fs.renameSync(`${state}.tmp`, state);
  };
  hub.onBeforeRespond(dump);
  dump();
  try {
    return await runScript([name], { HUB_URL: url, HUB_STATE: state, VID, LAUNCH });
  } finally {
    await hub.close();
  }
}

describe("test/boot.test.sh", () => {
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

      // Assert
      expect(run.fails, run.out).toEqual([]);
      expect(run.oks.length, run.out).toBeGreaterThan(0);
      expect(run.summary, run.out).toEqual({ passed: run.oks.length, failed: 0 });
      expect(run.code, run.out).toBe(0);
    },
    CASE_TIMEOUT
  );
});
