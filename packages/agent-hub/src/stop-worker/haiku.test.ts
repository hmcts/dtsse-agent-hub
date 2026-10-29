import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { haikuCommand, runHaiku, summariserSettings } from "./haiku.ts";

const LIGHT = ["--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];

let home: TempClaudeHome;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const [k, v] of Object.entries(home.env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  home.cleanup();
});

const settingsOf = (env: Record<string, string>, root: string): Record<string, unknown> => {
  const { args } = haikuCommand(env, root);
  expect(args.filter((a) => a === "--settings")).toHaveLength(1);
  return JSON.parse(args[args.indexOf("--settings") + 1] as string);
};

describe("haikuCommand", () => {
  it("should run on the session's own auth without --bare, hooks, tools or MCP whatever the model route", () => {
    // Act & Assert
    for (const route of [undefined, "own_licence", "gateway"]) {
      const env: Record<string, string> = route ? { AGENT_HUB_MODEL_ROUTE: route } : {};
      const { bin, args } = haikuCommand(env, home.root);
      expect(bin).toBe("claude");
      expect(args, `route ${route}`).toEqual(["-p", "--model", "haiku", "--settings", '{"disableAllHooks":true}', ...LIGHT]);
    }
    expect(haikuCommand({ AGENT_HUB_CLAUDE_BIN: "/x/claude" }, home.root).bin).toBe("/x/claude");
  });

  it("should fold AGENT_HUB_CLAUDE_SETTINGS into the one --settings and still disable hooks", () => {
    // Arrange
    fs.mkdirSync(path.join(home.root, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home.root, ".claude", "s.json"), JSON.stringify({ crossSessionInbound: "accept", disableAllHooks: false, env: { A: "1" } }));

    // Act & Assert: Claude Code keeps only the last --settings, so there is exactly one.
    expect(settingsOf({ AGENT_HUB_CLAUDE_SETTINGS: ".claude/s.json" }, home.root)).toEqual({
      crossSessionInbound: "accept",
      disableAllHooks: true,
      env: { A: "1" }
    });
    expect(settingsOf({ AGENT_HUB_CLAUDE_SETTINGS: '{"crossSessionInbound":"accept"}' }, home.root)).toEqual({
      crossSessionInbound: "accept",
      disableAllHooks: true
    });
    expect(settingsOf({ AGENT_HUB_CLAUDE_SETTINGS: "missing.json" }, home.root)).toEqual({ disableAllHooks: true });
    expect(settingsOf({ AGENT_HUB_CLAUDE_SETTINGS: "{not json" }, home.root)).toEqual({ disableAllHooks: true });
  });

  it("should keep the credential helpers running from the workspace root whichever settings they came from", () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(home.root, "ws-o'k-"));
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: ".claude/project.sh", hooks: { Stop: [] }, env: { P: "1" } }));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ awsAuthRefresh: "scripts/aws-refresh" }));
    const cd = `cd '${root.replaceAll("'", "'\\''")}' && `;

    // Act & Assert: only the helpers come from project settings.
    expect(settingsOf({}, root)).toEqual({ apiKeyHelper: `${cd}.claude/project.sh`, awsAuthRefresh: `${cd}scripts/aws-refresh`, disableAllHooks: true });
    expect(settingsOf({ AGENT_HUB_CLAUDE_SETTINGS: '{"apiKeyHelper":".claude/token.sh"}' }, root).apiKeyHelper).toBe(`${cd}.claude/token.sh`);
  });

  it("should name the apiKeyHelper hai published when the session is on the gateway route", () => {
    // Arrange: the route's base url and APIM header reach the summariser by inheritance, so the
    // helper is the only part of the credential it has to name for itself.
    const helper = "/home/hmcts/.local/state/hai/gateway-token.sh";

    // Act & Assert: rooted like every other helper, which an absolute path is unaffected by.
    expect(settingsOf({ HAI_API_KEY_HELPER: helper }, home.root)).toEqual({
      apiKeyHelper: `cd '${home.root}' && ${helper}`,
      disableAllHooks: true
    });
  });

  it("should authenticate as it did before when hai published no helper", () => {
    // Act & Assert: an own-licence session has no helper at all, and so does a pod running a hai
    // that predates the variable.
    expect(settingsOf({}, home.root)).toEqual({ disableAllHooks: true });
    expect(settingsOf({ HAI_API_KEY_HELPER: "" }, home.root)).toEqual({ disableAllHooks: true });
    expect(settingsOf({ HAI_API_KEY_HELPER: "   " }, home.root)).toEqual({ disableAllHooks: true });
  });

  it("should let hai's published helper win over a settings file and lose to AGENT_HUB_CLAUDE_SETTINGS", () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(home.root, "ws-precedence-"));
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: ".claude/project.sh" }));
    const cd = `cd '${root}' && `;
    const published = "/home/hmcts/.local/state/hai/gateway-token.sh";

    // Act & Assert: hai names the credential the session is running on, rather than a file that
    // may describe another; an operator naming one explicitly is still the last word.
    expect(settingsOf({ HAI_API_KEY_HELPER: published }, root).apiKeyHelper).toBe(`${cd}${published}`);
    expect(settingsOf({ HAI_API_KEY_HELPER: published, AGENT_HUB_CLAUDE_SETTINGS: '{"apiKeyHelper":".claude/token.sh"}' }, root).apiKeyHelper).toBe(
      `${cd}.claude/token.sh`
    );
  });
});

describe("summariserSettings", () => {
  it("should read the workspace settings under the root it is given, not the module's own location", () => {
    // Arrange: two roots with different helpers, so a root that was ignored would be visible.
    const a = fs.mkdtempSync(path.join(home.root, "root-a-"));
    const b = fs.mkdtempSync(path.join(home.root, "root-b-"));
    fs.mkdirSync(path.join(a, ".claude"));
    fs.mkdirSync(path.join(b, ".claude"));
    fs.writeFileSync(path.join(a, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "a.sh" }));
    fs.writeFileSync(path.join(b, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "b.sh" }));

    // Act & Assert
    expect(JSON.parse(summariserSettings({}, a))).toEqual({ apiKeyHelper: `cd '${a}' && a.sh`, disableAllHooks: true });
    expect(JSON.parse(summariserSettings({}, b))).toEqual({ apiKeyHelper: `cd '${b}' && b.sh`, disableAllHooks: true });
  });

  it("should default its root to CLAUDE_PROJECT_DIR when it is set", () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(home.root, "project-dir-"));
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.local.json"), JSON.stringify({ gcpAuthRefresh: "gcp.sh" }));
    const before = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;

    // Act
    let settings: unknown;
    try {
      settings = JSON.parse(summariserSettings({}));
    } finally {
      if (before === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = before;
      }
    }

    // Assert
    expect(settings).toEqual({ gcpAuthRefresh: `cd '${root}' && gcp.sh`, disableAllHooks: true });
  });

  it("should leave a blank or non-string helper unrooted", () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(home.root, "blank-"));
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "   ", otelHeadersHelper: 7 }));

    // Act & Assert
    expect(JSON.parse(summariserSettings({}, root))).toEqual({ apiKeyHelper: "   ", otelHeadersHelper: 7, disableAllHooks: true });
  });

  it("should ignore settings files that are not JSON objects", () => {
    // Arrange
    const root = fs.mkdtempSync(path.join(home.root, "not-object-"));
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(path.join(root, ".claude", "settings.json"), "[1,2,3]");

    // Act & Assert
    expect(JSON.parse(summariserSettings({}, root))).toEqual({ disableAllHooks: true });
  });
});

describe("runHaiku", () => {
  it("should start the summariser in a private directory outside the workspace", async () => {
    // Arrange
    const bin = path.join(home.root, "fake-haiku-cwd");
    fs.writeFileSync(bin, '#!/usr/bin/env bash\nprintf \'{"result": "%s"}\' "$PWD"\n', { mode: 0o755 });
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(home.root, "ws-")));
    const env = { ...process.env, AGENT_HUB_CLAUDE_BIN: bin };

    // Act
    const out = await runHaiku("prompt", { env, root: ws });

    // Assert
    const cwd = fs.realpathSync(JSON.parse(out).result);
    expect(cwd).not.toBe(ws);
    expect(cwd.startsWith(`${ws}${path.sep}`)).toBe(false);
    expect(cwd).toBe(fs.realpathSync(path.join(home.hub, "summariser-cwd")));
    expect(fs.statSync(cwd).mode & 0o077, "private to the user").toBe(0);
  });

  it("should inherit the session's Bedrock-protocol environment when it is on the gateway route", async () => {
    // Arrange
    const gateway: Record<string, string> = { AGENT_HUB_MODEL_ROUTE: "gateway" };
    expect(haikuCommand(gateway, home.root).args).not.toContain("--bare");
    const bin = path.join(home.root, "fake-haiku");
    fs.writeFileSync(
      bin,
      '#!/usr/bin/env bash\nprintf \'{"result": "%s|%s|%s|%s"}\' "$CLAUDE_CODE_USE_BEDROCK" "$AWS_BEARER_TOKEN_BEDROCK" "$AWS_REGION" "$ANTHROPIC_DEFAULT_HAIKU_MODEL"\n',
      {
        mode: 0o755
      }
    );
    const env = {
      ...process.env,
      ...gateway,
      AGENT_HUB_CLAUDE_BIN: bin,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "gateway-minted-token",
      AWS_REGION: "eu-west-2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
    };

    // Act
    const out = await runHaiku("prompt", { env, root: home.root });

    // Assert
    expect(JSON.parse(out).result).toBe("1|gateway-minted-token|eu-west-2|eu.anthropic.claude-haiku-4-5-20251001-v1:0");
  });

  it("should drop the session's messaging socket and id so the child cannot act as the session", async () => {
    // Arrange
    const bin = path.join(home.root, "fake-haiku-env");
    fs.writeFileSync(
      bin,
      '#!/usr/bin/env bash\nprintf \'{"result": "%s|%s|%s|%s"}\' "$CLAUDE_CODE_MESSAGING_SOCKET" "$CLAUDE_CODE_MESSAGING_TOKEN" "$CLAUDE_CODE_SESSION_ID" "$AGENT_HUB_CHILD"\n',
      {
        mode: 0o755
      }
    );
    const env = {
      ...process.env,
      AGENT_HUB_CLAUDE_BIN: bin,
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      CLAUDE_CODE_SESSION_ID: "sess-1"
    };

    // Act
    const out = await runHaiku("prompt", { env, root: home.root });

    // Assert
    expect(JSON.parse(out).result).toBe("|||1");
  });

  it("should reject with the command's stderr when it exits non-zero", async () => {
    // Arrange
    const bin = path.join(home.root, "fake-haiku-fail");
    fs.writeFileSync(bin, "#!/usr/bin/env bash\necho 'no auth' >&2\nexit 4\n", { mode: 0o755 });

    // Act & Assert
    await expect(runHaiku("prompt", { env: { ...process.env, AGENT_HUB_CLAUDE_BIN: bin }, root: home.root })).rejects.toThrow(/exited 4: no auth/);
  });

  it("should reject when the binary cannot be run at all", async () => {
    // Act & Assert
    await expect(
      runHaiku("prompt", { env: { ...process.env, AGENT_HUB_CLAUDE_BIN: path.join(home.root, "no-such-claude") }, root: home.root })
    ).rejects.toThrow();
  });
});
