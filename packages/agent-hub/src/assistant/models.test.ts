// The model a conversation's session runs on: the id's shape, what the launcher is given on each route, and the
// `/model` switch the bridge makes before delivering a message that asks for another.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { fakeTmux } from "../__fixtures__/fake-tmux.ts";
import { ensureStateDir, readText } from "../session.ts";
import { launcherModel, modelPath, parseModel, switchModel } from "./models.ts";
import { tmuxName } from "./tmux.ts";

const CONVERSATION = "0f8a6a1e-1234-4000-8000-000000000001";
const BEDROCK_EU = { AWS_REGION: "eu-west-2" };

let home: TempClaudeHome;
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
  home.cleanup();
});

let sessions = 0;
function session(): string {
  sessions += 1;
  const sid = `00000000-0000-4000-8000-${sessions.toString(16).padStart(12, "0")}`;
  ensureStateDir(sid);
  return sid;
}

const write = (file: string, text: string) => fs.writeFileSync(file, text);

describe("parseModel", () => {
  it.each([["claude-sonnet-5-5"], ["claude-opus-5-5"], ["claude-haiku-5-5"], ["claude-fable-5"]])("should keep %s when it is the shape of a model id", (id) => {
    // Act & Assert
    expect(parseModel(id)).toBe(id);
  });

  it.each([
    ["claude-sonnet-5-5 --dangerously-skip-permissions"],
    ["claude-sonnet-5-5'; rm -rf /'"],
    ["eu.anthropic.claude-sonnet-5-5"],
    ["claude-sonnet-5-5[1m]"],
    ["sonnet"],
    [""],
    [7],
    [null],
    [undefined]
  ])("should be null when the model is %j, which is not the shape of an id", (value) => {
    // Act & Assert
    expect(parseModel(value)).toBeNull();
  });
});

describe("launcherModel", () => {
  it("should give the id itself when the pod is on its owner's own Claude licence", () => {
    // Act & Assert
    expect(launcherModel("claude-opus-5-5", { AGENT_HUB_MODEL_ROUTE: "own_licence" })).toBe("claude-opus-5-5");
  });

  it("should give the eu inference profile with the long context, as hai's defaults are, when the pod is on Bedrock in eu-west-2", () => {
    // Act & Assert
    expect(launcherModel("claude-sonnet-5-5", { AGENT_HUB_MODEL_ROUTE: "bedrock", ...BEDROCK_EU })).toBe("eu.anthropic.claude-sonnet-5-5[1m]");
    expect(launcherModel("claude-opus-5-5", { AGENT_HUB_MODEL_ROUTE: "bedrock", ...BEDROCK_EU })).toBe("eu.anthropic.claude-opus-5-5[1m]");
    expect(launcherModel("claude-haiku-5-5", { AGENT_HUB_MODEL_ROUTE: "bedrock", ...BEDROCK_EU })).toBe("eu.anthropic.claude-haiku-5-5");
  });

  it("should take Bedrock in hai's default region when no route or region is set", () => {
    // Act & Assert
    expect(launcherModel("claude-sonnet-5-5", {})).toBe("eu.anthropic.claude-sonnet-5-5[1m]");
  });

  it("should name the region's own profile when hai is pointed at another region", () => {
    // Act & Assert
    expect(launcherModel("claude-haiku-5-5", { AWS_REGION: "us-east-1" })).toBe("us.anthropic.claude-haiku-5-5");
    expect(launcherModel("claude-haiku-5-5", { AWS_REGION: "ap-southeast-2" })).toBe("apac.anthropic.claude-haiku-5-5");
  });

  it("should be null when the region has no known profile or the id is not one", () => {
    // Act & Assert
    expect(launcherModel("claude-sonnet-5-5", { AWS_REGION: "ca-central-1" })).toBeNull();
    expect(launcherModel("claude-sonnet-5-5 && curl evil", BEDROCK_EU)).toBeNull();
    expect(launcherModel(null, BEDROCK_EU)).toBeNull();
  });
});

describe("switchModel", () => {
  it("should type /model into the conversation's pane and record it when the message asks for another model", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "claude-sonnet-5-5\n");
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "claude-opus-5-5", env: BEDROCK_EU, tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("switched");
    expect(tmux.sent(tmuxName(CONVERSATION))).toEqual([
      ["send-keys", tmuxName(CONVERSATION), "-l", "/model eu.anthropic.claude-opus-5-5[1m]"],
      ["send-keys", tmuxName(CONVERSATION), "Enter"]
    ]);
    expect(readText(modelPath(sid))).toBe("claude-opus-5-5");
  });

  it("should send nothing when the session is already on the model the message asks for", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "claude-opus-5-5\n");
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "claude-opus-5-5", env: BEDROCK_EU, tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("unchanged");
    expect(tmux.calls).toEqual([]);
  });

  it("should switch when no model is recorded for the session, which is one started on hai's default", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({
      sid,
      conversationId: CONVERSATION,
      model: "claude-haiku-5-5",
      env: { AGENT_HUB_MODEL_ROUTE: "own_licence" },
      tmux,
      write,
      settleMs: 0
    });

    // Assert
    expect(outcome).toBe("switched");
    expect(tmux.sent(tmuxName(CONVERSATION))[0]).toEqual(["send-keys", tmuxName(CONVERSATION), "-l", "/model claude-haiku-5-5"]);
  });

  it("should send nothing when the frame names no model, as one from an older hub does", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: null, env: BEDROCK_EU, tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("unchanged");
    expect(tmux.calls).toEqual([]);
  });

  it("should leave the record alone, so the next message tries again, when the keys could not be sent", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "claude-sonnet-5-5\n");
    const said: string[] = [];
    const tmux = {
      sendKeys: async () => {
        throw new Error("tmux send-keys exited 1: can't find session");
      }
    };

    // Act
    const outcome = await switchModel({
      sid,
      conversationId: CONVERSATION,
      model: "claude-opus-5-5",
      env: BEDROCK_EU,
      tmux,
      write,
      settleMs: 0,
      say: (m) => said.push(m)
    });

    // Assert
    expect(outcome).toBe("failed");
    expect(readText(modelPath(sid))).toBe("claude-sonnet-5-5");
    expect(said.join("\n")).toContain("can't find session");
  });

  it("should send nothing when the route has no launcher model for it", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({
      sid,
      conversationId: CONVERSATION,
      model: "claude-opus-5-5",
      env: { AWS_REGION: "ca-central-1" },
      tmux,
      write,
      settleMs: 0
    });

    // Assert
    expect(outcome).toBe("skipped");
    expect(tmux.calls).toEqual([]);
  });
});

describe("launcherModel for a family Bedrock has no profile for", () => {
  it("should be null for Fable on Bedrock, so the session keeps hai's default, and its own id on a licence", () => {
    // Act & Assert
    expect(launcherModel("claude-fable-5-1", BEDROCK_EU)).toBeNull();
    expect(launcherModel("claude-fable-5-1", { AGENT_HUB_MODEL_ROUTE: "own_licence" })).toBe("claude-fable-5-1");
  });
});
