import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll } from "vitest";

export type TempClaudeHome = {
  root: string;
  claude: string;
  hub: string;
  env: { HOME: string; CLAUDE_CONFIG_DIR: string };
  cleanup: () => void;
};

// Points every ~/.claude lookup at a throwaway directory. Its user settings accept
// cross-session messages, as the bridge would otherwise hold every direct message.
export function tempClaudeHome({ userSettings = { crossSessionInbound: "accept" } }: { userSettings?: unknown } = {}): TempClaudeHome {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-"));
  const claude = path.join(root, ".claude");
  fs.mkdirSync(path.join(claude, "sessions"), { recursive: true });
  if (userSettings) {
    fs.writeFileSync(path.join(claude, "settings.json"), `${JSON.stringify(userSettings, null, 2)}\n`);
  }
  return {
    root,
    claude,
    hub: path.join(claude, "agent-hub"),
    env: { HOME: root, CLAUDE_CONFIG_DIR: claude },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

// A temp Claude home for every test in the calling file, with HOME and CLAUDE_CONFIG_DIR pointed at it and put back
// afterwards. The getter is only valid once the file's beforeAll has run.
export function useTempClaudeHome(): () => TempClaudeHome {
  let home: TempClaudeHome | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    home = tempClaudeHome();
    for (const key of ["HOME", "CLAUDE_CONFIG_DIR"]) {
      savedEnv[key] = process.env[key];
    }
    Object.assign(process.env, home.env);
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    home?.cleanup();
  });

  return () => {
    if (!home) {
      throw new Error("the temp Claude home is only made in beforeAll");
    }
    return home;
  };
}

// Built at runtime so no secret-shaped literal sits in the repo. This tree is published, so this matters more
// here than it did in the workspace it came from.
export const fakeSecrets = {
  githubToken: `${"gh"}p_${"A1b2C3d4".repeat(4)}`,
  jwt: `${"ey"}J${"a".repeat(24)}.payload.sig`,
  accountKey: `DefaultEndpointsProtocol=https;${"Account"}Key=abc`,
  privateKey: `-----${"BEGIN"} RSA PRIVATE KEY-----`,
  password: `${"pass"}word: "${"Zx9".repeat(6)}"`
};
