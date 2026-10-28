// The model a conversation's session runs on: the id's shape, what the launcher is given for it, and the `/model`
// switch the bridge makes before delivering a message that asks for another.
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "../__fixtures__/claude-home.ts";
import { fakeTmux } from "../__fixtures__/fake-tmux.ts";
import { ensureStateDir, readText } from "../session.ts";
import { launcherModel, modelPath, parseModel, switchModel } from "./models.ts";
import { tmuxName } from "./tmux.ts";

const CONVERSATION = "0f8a6a1e-1234-4000-8000-000000000001";

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
  it.each([["sonnet"], ["opus"]])("should keep %s when it is the shape of a model id", (id) => {
    // Act & Assert
    expect(parseModel(id)).toBe(id);
  });

  it.each([
    ["sonnet --dangerously-skip-permissions"],
    ["sonnet'; rm -rf /'"],
    ["claude-sonnet-5-5"],
    ["eu.anthropic.claude-sonnet-5-5"],
    ["sonnet[1m]"],
    ["Sonnet"],
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
  it.each([["sonnet"], ["opus"]])("should give the alias itself for %s, which hai pins the version of, on either route", (id) => {
    // Act & Assert
    expect(launcherModel(id)).toBe(id);
  });

  it("should be null when the id is not one, so the session keeps hai's default", () => {
    // Act & Assert
    expect(launcherModel("sonnet && curl evil")).toBeNull();
    expect(launcherModel(null)).toBeNull();
  });
});

describe("switchModel", () => {
  it("should type /model into the conversation's pane and record it when the message asks for another model", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "sonnet\n");
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "opus", tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("switched");
    expect(tmux.sent(tmuxName(CONVERSATION))).toEqual([
      ["send-keys", tmuxName(CONVERSATION), "-l", "/model opus"],
      ["send-keys", tmuxName(CONVERSATION), "Enter"]
    ]);
    expect(readText(modelPath(sid))).toBe("opus");
  });

  it("should send nothing when the session is already on the model the message asks for", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "opus\n");
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "opus", tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("unchanged");
    expect(tmux.calls).toEqual([]);
  });

  it("should switch when no model is recorded for the session, which is one started on hai's default", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "opus", tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("switched");
    expect(tmux.sent(tmuxName(CONVERSATION))[0]).toEqual(["send-keys", tmuxName(CONVERSATION), "-l", "/model opus"]);
  });

  it("should send nothing when the frame names no model, as one from an older hub does", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: null, tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("unchanged");
    expect(tmux.calls).toEqual([]);
  });

  it("should leave the record alone, so the next message tries again, when the keys could not be sent", async () => {
    // Arrange
    const sid = session();
    write(modelPath(sid), "sonnet\n");
    const said: string[] = [];
    const tmux = {
      sendKeys: async () => {
        throw new Error("tmux send-keys exited 1: can't find session");
      }
    };

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "opus", tmux, write, settleMs: 0, say: (m) => said.push(m) });

    // Assert
    expect(outcome).toBe("failed");
    expect(readText(modelPath(sid))).toBe("sonnet");
    expect(said.join("\n")).toContain("can't find session");
  });

  it("should send nothing when the frame's model is not the shape of an id", async () => {
    // Arrange
    const sid = session();
    const tmux = fakeTmux();

    // Act
    const outcome = await switchModel({ sid, conversationId: CONVERSATION, model: "opus; curl evil", tmux, write, settleMs: 0 });

    // Assert
    expect(outcome).toBe("skipped");
    expect(tmux.calls).toEqual([]);
  });
});
