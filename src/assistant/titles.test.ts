import { describe, expect, it } from "vitest";
import { firstPromptTitle, localTitle, messageTitle, type PromptEntry, TITLE_FROM_MESSAGE, TITLE_MAX } from "./titles.ts";

function prompt(text: unknown, overrides: Partial<PromptEntry> = {}): PromptEntry {
  return { content: { text }, redacted: false, messageId: null, ...overrides };
}

describe("localTitle", () => {
  it("should collapse the name a session reported when it is usable as a title", () => {
    expect(localTitle("  fix the  local chat\ttitles ")).toBe("fix the local chat titles");
    expect(localTitle("hmcts-25")).toBe("hmcts-25");
  });

  it("should cut a long name to the longest title a conversation can carry", () => {
    expect(localTitle("a".repeat(TITLE_MAX + 50))).toHaveLength(TITLE_MAX);
  });

  it("should be null when the name is empty or nothing but whitespace", () => {
    expect(localTitle("")).toBeNull();
    expect(localTitle("   \n ")).toBeNull();
  });
});

describe("messageTitle", () => {
  it("should be the start of the message on one line when there are words in it", () => {
    expect(messageTitle("  why can't\n\nthis user see tasks?  ")).toBe("why can't this user see tasks?");
  });

  it("should cut a long message to the length a title takes from one", () => {
    expect(messageTitle("word ".repeat(100))).toHaveLength(TITLE_FROM_MESSAGE);
  });

  it("should be null when the message is nothing but whitespace", () => {
    expect(messageTitle(" \t\n ")).toBeNull();
  });
});

describe("firstPromptTitle", () => {
  it("should name the chat after its first prompt when that prompt has words in it", () => {
    expect(firstPromptTitle([prompt("fix the local chat titles"), prompt("and the hub half of it")])).toBe("fix the local chat titles");
  });

  it("should pass over a redacted prompt, which holds the pattern it matched and no words", () => {
    const redacted: PromptEntry = { content: { redacted: "azure-client-secret" }, redacted: true, messageId: null };

    expect(firstPromptTitle([redacted, prompt("now try it without the secret")])).toBe("now try it without the secret");
  });

  it("should pass over a prompt that is a hub message relayed into the session", () => {
    expect(firstPromptTitle([prompt("[agent-hub] Direct message #12 from bob: ping", { messageId: 12n }), prompt("what did bob want?")])).toBe(
      "what did bob want?"
    );
  });

  it("should pass over a prompt whose text is whitespace or is not text at all", () => {
    expect(firstPromptTitle([prompt("   "), prompt(7), { content: "not an entry", redacted: false, messageId: null }, prompt("the real one")])).toBe(
      "the real one"
    );
  });

  it("should be null when there are no prompts, and when none of them can name a chat", () => {
    expect(firstPromptTitle([])).toBeNull();
    expect(firstPromptTitle([prompt(""), { content: null, redacted: false, messageId: null }])).toBeNull();
  });

  it("should cut the prompt it chose to the length a title takes from a message", () => {
    expect(firstPromptTitle([prompt("x".repeat(TITLE_FROM_MESSAGE + 20))])).toHaveLength(TITLE_FROM_MESSAGE);
  });
});

describe("firstPromptTitle and the harness's own turns", () => {
  const prompt = (text: string) => ({ content: { text }, redacted: false, messageId: null });

  it("should skip a slash command's record and name the chat after what the person typed next", () => {
    const entries = [
      prompt("<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>"),
      prompt("<local-command-stdout></local-command-stdout>"),
      prompt("fix the search page")
    ];

    expect(firstPromptTitle(entries)).toBe("fix the search page");
  });

  it("should name nothing when every prompt offered was written by the harness", () => {
    expect(firstPromptTitle([prompt("<task-notification><status>completed</status></task-notification>")])).toBeNull();
  });

  it("should keep a prompt that only mentions a tag further in", () => {
    expect(firstPromptTitle([prompt("why does <command-name> show up in titles?")])).toBe("why does <command-name> show up in titles?");
  });
});
