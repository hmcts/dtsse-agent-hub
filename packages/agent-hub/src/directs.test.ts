// The session's own record of its direct messages. The workspace had no standalone suite for this module — it
// was only exercised through the bridge and the CLI — so these are direct tests of each function.
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type TempClaudeHome, tempClaudeHome } from "./__fixtures__/claude-home.ts";
import { type DirectEntry, parseDirectEntry, peerOf, peerOfReply, readDirects, recordDirect } from "./directs.ts";
import { ensureStateDir, statePath } from "./session.ts";

const SID = "sess-directs";
const ALICE = { key: "agent:a1", name: "@alice" };
const BOB = { key: "user:bob@example.com", name: "Bob Jones" };

let home: TempClaudeHome;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  home = tempClaudeHome();
  for (const [key, value] of Object.entries(home.env)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
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

beforeEach(() => {
  fs.rmSync(home.hub, { recursive: true, force: true });
  ensureStateDir(SID);
});

const file = () => statePath(SID, "directs.jsonl");
const lines = () => fs.readFileSync(file(), "utf8").trim().split("\n");

describe("peerOf", () => {
  it("should key on the agent id and name it with an @ when an agent wrote the message", () => {
    // Act
    const peer = peerOf({ type: "agent", agent_id: "a1", agent_name: "alice", owner_name: "Alice" });

    // Assert
    expect(peer).toEqual({ key: "agent:a1", name: "@alice" });
  });

  it("should key on the owner email and name them when a person wrote the message", () => {
    // Act & Assert
    expect(peerOf({ type: "user", owner_name: "Bob Jones", owner_email: "bob@example.com" })).toEqual({ key: "user:bob@example.com", name: "Bob Jones" });
  });

  it("should fall back to the owner name as the key when there is no email", () => {
    // Act & Assert
    expect(peerOf({ type: "user", owner_name: "Bob Jones" })).toEqual({ key: "user:Bob Jones", name: "Bob Jones" });
  });

  it("should be unknown when the author says nothing usable", () => {
    // Act & Assert
    expect(peerOf()).toEqual({ key: "user:unknown", name: "unknown" });
    expect(peerOf({ type: "agent", agent_name: "nameless" })).toEqual({ key: "user:unknown", name: "unknown" });
  });
});

describe("recordDirect", () => {
  it("should append one JSON line carrying the direction, peer and message when a message is recorded", () => {
    // Act
    recordDirect(
      SID,
      { id: "7", body: "hello", created_at: "2026-10-09T00:00:00.000Z", author: { type: "agent", agent_id: "a1" } },
      { direction: "in", peer: ALICE }
    );

    // Assert
    expect(lines()).toHaveLength(1);
    expect(JSON.parse(lines()[0] as string)).toEqual({
      id: "7",
      direction: "in",
      peer: ALICE,
      in_reply_to: null,
      created_at: "2026-10-09T00:00:00.000Z",
      author: { type: "agent", agent_id: "a1" },
      body: "hello"
    });
  });

  it("should create the state directory and write the file private when there is none yet", () => {
    // Arrange
    fs.rmSync(home.hub, { recursive: true, force: true });

    // Act
    recordDirect(SID, { id: "1", body: "first" }, { direction: "out", peer: BOB });

    // Assert
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
  });

  it("should stamp the current time and a null author when the message carries neither", () => {
    // Act
    recordDirect(SID, { id: "1", body: "no metadata" }, { direction: "out", peer: BOB });

    // Assert
    const [entry] = readDirects(SID);
    expect(entry?.author).toBeNull();
    expect(Date.parse(entry?.created_at ?? "")).toBeGreaterThan(0);
  });

  it("should record the message it answers when the message is a reply", () => {
    // Act
    recordDirect(SID, { id: "9", body: "answer", in_reply_to: "7" }, { direction: "out", peer: ALICE });

    // Assert
    expect(readDirects(SID)[0]?.in_reply_to).toBe("7");
  });

  it("should write nothing when the same message id is recorded twice", () => {
    // Act
    recordDirect(SID, { id: "7", body: "hello" }, { direction: "in", peer: ALICE });
    recordDirect(SID, { id: "7", body: "hello again" }, { direction: "in", peer: ALICE });

    // Assert
    expect(readDirects(SID).map((d) => d.body)).toEqual(["hello"]);
  });

  it("should rewrite the file keeping the newest 500 when the queue is already full", () => {
    // Arrange
    for (let i = 0; i < 500; i++) {
      recordDirect(SID, { id: String(i), body: `m${i}` }, { direction: "in", peer: ALICE });
    }

    // Act
    recordDirect(SID, { id: "500", body: "m500" }, { direction: "in", peer: ALICE });

    // Assert
    const entries = readDirects(SID);
    expect(entries).toHaveLength(500);
    expect(entries[0]?.id).toBe("1");
    expect(entries.at(-1)?.id).toBe("500");
  });
});

describe("readDirects", () => {
  it("should be empty when the session has recorded nothing", () => {
    // Act & Assert
    expect(readDirects(SID)).toEqual([]);
  });

  it("should skip blank lines and lines that are not entries when the file has been corrupted", () => {
    // Arrange
    fs.writeFileSync(
      file(),
      ['{"id":"1","body":"kept","direction":"in","peer":{"key":"k","name":"n"}}', "{not json", "   ", "[1]", '{"body":"no id"}', ""].join("\n")
    );

    // Act
    const entries = readDirects(SID);

    // Assert
    expect(entries.map((d) => d.body)).toEqual(["kept"]);
  });
});

describe("parseDirectEntry", () => {
  it("should fill in the defaults when a stored entry is missing fields", () => {
    // Act
    const entry = parseDirectEntry({ id: "1", body: "x" });

    // Assert
    expect(entry).toEqual({ id: "1", direction: "in", peer: { key: "unknown", name: "unknown" }, in_reply_to: null, created_at: "", author: null, body: "x" });
  });

  it("should be null when the value is not an entry", () => {
    // Act & Assert
    for (const value of [null, 7, "x", [], {}, { id: 1, body: "x" }, { id: "1" }]) {
      expect(parseDirectEntry(value)).toBeNull();
    }
  });

  it("should keep the direction only when it is out", () => {
    // Act & Assert
    expect(parseDirectEntry({ id: "1", body: "x", direction: "out" })?.direction).toBe("out");
    expect(parseDirectEntry({ id: "1", body: "x", direction: "sideways" })?.direction).toBe("in");
  });
});

describe("peerOfReply", () => {
  it("should be the peer of the message being answered when this session recorded it", () => {
    // Arrange
    recordDirect(SID, { id: "7", body: "question" }, { direction: "in", peer: ALICE });

    // Act & Assert
    expect(peerOfReply(SID, "7", null)).toEqual(ALICE);
    expect(peerOfReply(SID, 7, null)).toEqual(ALICE);
  });

  it("should be the fallback when the message being answered was never recorded", () => {
    // Act & Assert
    expect(peerOfReply(SID, "404", BOB)).toEqual(BOB);
    expect(peerOfReply(SID, "404", null)).toBeNull();
  });
});

describe("round trip", () => {
  it("should read back exactly what it wrote when several messages are recorded", () => {
    // Arrange
    const written: DirectEntry[] = [];

    // Act
    for (const [id, direction, peer] of [
      ["1", "in", ALICE],
      ["2", "out", ALICE],
      ["3", "in", BOB]
    ] as const) {
      recordDirect(SID, { id, body: `body ${id}`, created_at: `2026-10-0${id}T00:00:00.000Z` }, { direction, peer });
      written.push({ id, direction, peer, in_reply_to: null, created_at: `2026-10-0${id}T00:00:00.000Z`, author: null, body: `body ${id}` });
    }

    // Assert
    expect(readDirects(SID)).toEqual(written);
  });
});
