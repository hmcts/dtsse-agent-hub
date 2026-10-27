import { describe, expect, it } from "vitest";
import {
  ASKED_REASON,
  denyOutput,
  MAX_HEADER,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTION_LABEL,
  MAX_QUESTION,
  MAX_QUESTIONS,
  parseQuestions,
  UNDELIVERED_REASON
} from "./questions.ts";

// The payload Claude Code v2.1.304 sends a PreToolUse hook for AskUserQuestion, verified against a live session.
const TOOL_INPUT = {
  questions: [
    {
      question: "Do you prefer red or blue?",
      header: "Color",
      options: [
        { label: "Red", description: "You prefer red." },
        { label: "Blue", description: "You prefer blue." }
      ],
      multiSelect: false
    }
  ]
};

function option(label: string) {
  return { label, description: `about ${label}` };
}

function question(overrides: Record<string, unknown> = {}) {
  return { question: "Which?", header: "Pick", options: [option("One"), option("Two")], multiSelect: false, ...overrides };
}

describe("parseQuestions", () => {
  it("should keep the whole question set when the payload is the tool's own shape", () => {
    // Act & Assert
    expect(parseQuestions(TOOL_INPUT)).toEqual(TOOL_INPUT.questions);
  });

  it("should read multiSelect as true only when it is the boolean", () => {
    // Act & Assert
    expect(parseQuestions({ questions: [question({ multiSelect: true })] })?.[0]?.multiSelect).toBe(true);
    expect(parseQuestions({ questions: [question({ multiSelect: "yes" })] })?.[0]?.multiSelect).toBe(false);
    expect(parseQuestions({ questions: [question({ multiSelect: undefined })] })?.[0]?.multiSelect).toBe(false);
  });

  it("should give an option with no description an empty one, since the tool allows it", () => {
    // Act
    const parsed = parseQuestions({ questions: [question({ options: [{ label: "One" }, { label: "Two", description: "  " }] })] });

    // Assert
    expect(parsed?.[0]?.options).toEqual([
      { label: "One", description: "" },
      { label: "Two", description: "" }
    ]);
  });

  it("should trim and cut every string to the length the hub accepts", () => {
    // Arrange
    const long = question({
      question: `  ${"q".repeat(MAX_QUESTION + 50)}  `,
      header: "h".repeat(MAX_HEADER + 50),
      options: [
        { label: "l".repeat(MAX_OPTION_LABEL + 50), description: "d".repeat(MAX_OPTION_DESCRIPTION + 50) },
        { label: " Two ", description: " second " }
      ]
    });

    // Act
    const parsed = parseQuestions({ questions: [long] });

    // Assert
    expect(parsed?.[0]?.question).toBe("q".repeat(MAX_QUESTION));
    expect(parsed?.[0]?.header).toBe("h".repeat(MAX_HEADER));
    expect(parsed?.[0]?.options[0]).toEqual({ label: "l".repeat(MAX_OPTION_LABEL), description: "d".repeat(MAX_OPTION_DESCRIPTION) });
    expect(parsed?.[0]?.options[1]).toEqual({ label: "Two", description: "second" });
  });

  it("should drop the questions past the cap, which the tool itself refuses", () => {
    // Arrange
    const many = Array.from({ length: MAX_QUESTIONS + 3 }, (_, index) => question({ header: `h${index}` }));

    // Act
    const parsed = parseQuestions({ questions: many });

    // Assert
    expect(parsed?.map((entry) => entry.header)).toEqual(["h0", "h1", "h2", "h3"]);
  });

  it("should keep only the options up to the cap when the model offered more", () => {
    // Act
    const parsed = parseQuestions({ questions: [question({ options: ["a", "b", "c", "d", "e"].map(option) })] });

    // Assert
    expect(parsed?.[0]?.options.map((entry) => entry.label)).toEqual(["a", "b", "c", "d"]);
  });

  it("should be null when there is nothing usable to put on screen", () => {
    // Act & Assert
    expect(parseQuestions(undefined)).toBeNull();
    expect(parseQuestions("Do you prefer red or blue?")).toBeNull();
    expect(parseQuestions({ questions: [] })).toBeNull();
    expect(parseQuestions({ questions: {} })).toBeNull();
    expect(parseQuestions({ questions: [question({ question: "  " })] })).toBeNull();
    expect(parseQuestions({ questions: [question({ header: null })] })).toBeNull();
    expect(parseQuestions({ questions: [question({ options: undefined })] })).toBeNull();
  });

  it("should be null when a question offers fewer than two readable options, since the choice would change", () => {
    // Act & Assert
    expect(parseQuestions({ questions: [question({ options: [option("One")] })] })).toBeNull();
    expect(parseQuestions({ questions: [question({ options: [option("One"), { label: "  " }] })] })).toBeNull();
    expect(parseQuestions({ questions: [question({ options: [option("One"), "Two"] })] })).toBeNull();
  });

  it("should be null when any question in the set is unreadable, rather than asking a shorter set", () => {
    // Act & Assert
    expect(parseQuestions({ questions: [question(), question({ question: "" })] })).toBeNull();
  });
});

describe("denyOutput", () => {
  it("should be the documented PreToolUse decision when it carries a reason", () => {
    // Act & Assert
    expect(denyOutput(ASKED_REASON)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: ASKED_REASON }
    });
  });

  // The model reads one of these as the tool's error and nothing else, so each has to say what to do next on its own.
  it("should offer two reasons that differ in what the model is told to do", () => {
    // Act & Assert
    expect(ASKED_REASON).toMatch(/do not repeat the question/i);
    expect(UNDELIVERED_REASON).toMatch(/plain words/i);
    expect(ASKED_REASON).not.toBe(UNDELIVERED_REASON);
  });
});
