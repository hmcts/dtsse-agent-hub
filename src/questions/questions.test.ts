import { describe, expect, it } from "vitest";
import {
  answerMessage,
  checkAnswer,
  MAX_ANSWER_TEXT,
  MAX_HEADER,
  MAX_QUESTION,
  MAX_QUESTIONS,
  offerExpired,
  QUESTION_OFFER_WINDOW_MS,
  type Question,
  questionPostBody,
  storedAnswer,
  storedQuestions
} from "./questions.ts";

function option(label: string) {
  return { label, description: `about ${label}` };
}

function question(overrides: Partial<Question> = {}): Question {
  return { question: "Which?", header: "Pick", options: [option("One"), option("Two")], multiSelect: false, ...overrides };
}

function body(overrides: Record<string, unknown> = {}) {
  return { session_id: "0f8a-sess", tool_use_id: "toolu_bdrk_01TNH", questions: [question()], ...overrides };
}

describe("questionPostBody", () => {
  it("should accept the body the client sends when it carries the tool's own shape", () => {
    // Act
    const parsed = questionPostBody.safeParse(body());

    // Assert
    expect(parsed.success).toBe(true);
    expect(parsed.data?.questions[0]?.options).toHaveLength(2);
  });

  it("should accept up to the caps and refuse anything past them", () => {
    // Act & Assert
    expect(questionPostBody.safeParse(body({ questions: Array.from({ length: MAX_QUESTIONS }, () => question()) })).success).toBe(true);
    expect(questionPostBody.safeParse(body({ questions: Array.from({ length: MAX_QUESTIONS + 1 }, () => question()) })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ questions: [] })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ questions: [question({ question: "q".repeat(MAX_QUESTION + 1) })] })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ questions: [question({ header: "h".repeat(MAX_HEADER + 1) })] })).success).toBe(false);
  });

  it("should refuse a question offering fewer than two or more than four options", () => {
    // Act & Assert
    expect(questionPostBody.safeParse(body({ questions: [question({ options: [option("One")] })] })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ questions: [question({ options: ["a", "b", "c", "d", "e"].map(option) })] })).success).toBe(false);
  });

  // The label is the whole of what an answer names: the card keys a press by it and the message the session gets
  // says it, so two options sharing one is a choice nobody could resolve.
  it("should refuse a question whose options share a label", () => {
    // Act
    const parsed = questionPostBody.safeParse(body({ questions: [question({ options: [option("One"), option("One")] })] }));

    // Assert
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("each option needs its own label");
  });

  it("should refuse a body missing the ids the row is keyed on, or carrying anything else", () => {
    // Act & Assert
    expect(questionPostBody.safeParse(body({ tool_use_id: "" })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ session_id: undefined })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ answer: "Red" })).success).toBe(false);
    expect(questionPostBody.safeParse(body({ questions: [{ ...question(), extra: 1 }] })).success).toBe(false);
  });

  it("should refuse a question that does not say whether more than one option may be chosen", () => {
    // Act & Assert
    expect(questionPostBody.safeParse(body({ questions: [{ question: "Which?", header: "Pick", options: [option("One"), option("Two")] }] })).success).toBe(
      false
    );
  });
});

describe("offerExpired", () => {
  const asked = new Date("2026-10-21T09:00:00.000Z");
  const later = (ms: number) => new Date(asked.getTime() + ms);

  it("should still offer a question inside the window it was asked in", () => {
    // Act & Assert
    expect(offerExpired(asked, asked)).toBe(false);
    expect(offerExpired(asked, later(QUESTION_OFFER_WINDOW_MS - 1))).toBe(false);
  });

  // Past the window, somebody who was going to answer is not coming, and the card has to stop claiming the
  // assistant is waiting on them. Whether an answer could still be delivered is a separate question: it could.
  it("should stop offering a question once the window has run out", () => {
    // Act & Assert
    expect(offerExpired(asked, later(QUESTION_OFFER_WINDOW_MS))).toBe(true);
    expect(offerExpired(asked, later(QUESTION_OFFER_WINDOW_MS * 10))).toBe(true);
  });

  /**
   * Two hours, and its own number rather than either idle stop: a conversation's session is sent `/exit` after 20
   * minutes and the whole pod after 120, so a question outliving the session that asked it is the normal case. It
   * is safe because such a session is restarted on its own id and comes back with the transcript it asked in, so
   * what this bound limits is the card's claim that the assistant is waiting, not whether an answer can arrive.
   */
  it("should outlive the session that asked, since a resumed session still has the transcript", () => {
    // Act & Assert
    expect(QUESTION_OFFER_WINDOW_MS).toBe(2 * 60 * 60_000);
  });
});

describe("storedQuestions", () => {
  it("should read back what was stored when the row is one this version wrote", () => {
    // Act & Assert
    expect(storedQuestions([question()])).toEqual([question()]);
  });

  it("should be empty when the row holds nothing this version can read", () => {
    // Act & Assert
    expect(storedQuestions(null)).toEqual([]);
    expect(storedQuestions([{ question: "Which?" }])).toEqual([]);
    expect(storedQuestions("Which?")).toEqual([]);
  });
});

describe("storedAnswer", () => {
  it("should read an answer of options, of words, or of both", () => {
    // Act & Assert
    expect(storedAnswer({ answers: [{ labels: ["One"], text: null }] })).toEqual({ answers: [{ labels: ["One"], text: null }] });
    expect(storedAnswer({ answers: [{ labels: [], text: "amber" }] })).toEqual({ answers: [{ labels: [], text: "amber" }] });
    expect(storedAnswer({ answers: [{ labels: ["One"], text: "because" }] })).toEqual({ answers: [{ labels: ["One"], text: "because" }] });
  });

  it("should drop anything in the labels that is not a label", () => {
    // Act & Assert
    expect(storedAnswer({ answers: [{ labels: ["One", 7, null] }] })).toEqual({ answers: [{ labels: ["One"], text: null }] });
  });

  it("should be null when the value is not an answer set at all", () => {
    // Act & Assert
    expect(storedAnswer(null)).toBeNull();
    expect(storedAnswer({ answers: "One" })).toBeNull();
    expect(storedAnswer({ answers: ["One"] })).toBeNull();
  });
});

describe("checkAnswer", () => {
  const two = [question({ header: "Colour", question: "Red or blue?", options: [option("Red"), option("Blue")] }), question({ header: "Size" })];

  it("should accept one option per question when every question was answered", () => {
    // Act
    const checked = checkAnswer(two, { answers: [{ labels: ["Red"] }, { labels: ["One"] }] });

    // Assert
    expect(checked).toEqual({
      ok: true,
      answer: {
        answers: [
          { labels: ["Red"], text: null },
          { labels: ["One"], text: null }
        ]
      }
    });
  });

  it("should accept several options when the question allows more than one", () => {
    // Act
    const checked = checkAnswer([question({ multiSelect: true })], { answers: [{ labels: ["One", "Two"] }] });

    // Assert
    expect(checked).toEqual({ ok: true, answer: { answers: [{ labels: ["One", "Two"], text: null }] } });
  });

  it("should refuse several options for a question that allows one", () => {
    // Act & Assert
    expect(checkAnswer([question()], { answers: [{ labels: ["One", "Two"] }] })).toEqual({
      ok: false,
      error: "only one option can be chosen for that question"
    });
  });

  it("should accept the person's own words in place of an option, since the tool always allows them", () => {
    // Act
    const checked = checkAnswer([question()], { answers: [{ labels: [], text: "  neither, actually  " }] });

    // Assert
    expect(checked).toEqual({ ok: true, answer: { answers: [{ labels: [], text: "neither, actually" }] } });
  });

  it("should cut words longer than the limit rather than refuse them", () => {
    // Act
    const checked = checkAnswer([question()], { answers: [{ labels: [], text: "w".repeat(MAX_ANSWER_TEXT + 50) }] });

    // Assert
    expect(checked.ok && checked.answer.answers[0]?.text).toBe("w".repeat(MAX_ANSWER_TEXT));
  });

  // The labels are what the message says, so a session must never be told its own option was chosen when it was not.
  it("should refuse a label the question did not offer", () => {
    // Act & Assert
    expect(checkAnswer([question()], { answers: [{ labels: ["Three"] }] })).toEqual({ ok: false, error: "that is not one of the options offered" });
  });

  // A browser sending the same label twice has chosen it once. Refusing it as an option that was never offered
  // would be both the wrong reason and an answer the person could not get through at all.
  it("should take a label sent twice as chosen once", () => {
    // Act & Assert
    expect(checkAnswer([question()], { answers: [{ labels: ["One", "One"] }] })).toEqual({
      ok: true,
      answer: { answers: [{ labels: ["One"], text: null }] }
    });
    expect(checkAnswer([question({ multiSelect: true })], { answers: [{ labels: ["One", "Two", "One"] }] })).toEqual({
      ok: true,
      answer: { answers: [{ labels: ["One", "Two"], text: null }] }
    });
  });

  it("should still refuse a repeated label beside one that was never offered", () => {
    // Act & Assert
    expect(checkAnswer([question({ multiSelect: true })], { answers: [{ labels: ["One", "One", "Three"] }] })).toEqual({
      ok: false,
      error: "that is not one of the options offered"
    });
  });

  it("should refuse a question answered with neither an option nor words", () => {
    // Act & Assert
    expect(checkAnswer([question()], { answers: [{ labels: [], text: "   " }] })).toEqual({ ok: false, error: "choose an option, or write your own answer" });
  });

  it("should refuse an answer that does not cover every question", () => {
    // Act & Assert
    expect(checkAnswer(two, { answers: [{ labels: ["Red"] }] })).toEqual({ ok: false, error: "answer every question before sending" });
    expect(checkAnswer(two, "Red")).toEqual({ ok: false, error: "answer every question before sending" });
  });
});

describe("answerMessage", () => {
  it("should quote the question back above the option chosen, so the session need not go looking for it", () => {
    // Act
    const body = answerMessage([question({ question: "Red or blue?" })], { answers: [{ labels: ["One"], text: null }] });

    // Assert
    expect(body).toBe("Answering your question.\n\nRed or blue?\nOne");
  });

  it("should say questions and give a block each when there was more than one", () => {
    // Act
    const body = answerMessage([question({ question: "Red or blue?" }), question({ question: "How big?" })], {
      answers: [
        { labels: ["One"], text: null },
        { labels: ["Two"], text: null }
      ]
    });

    // Assert
    expect(body).toBe("Answering your questions.\n\nRed or blue?\nOne\n\nHow big?\nTwo");
  });

  it("should join several chosen options into one phrase", () => {
    // Act
    const body = answerMessage([question({ question: "Which?", multiSelect: true })], { answers: [{ labels: ["One", "Two", "Three"], text: null }] });

    // Assert
    expect(body).toBe("Answering your question.\n\nWhich?\nOne, Two and Three");
  });

  it("should give the person's own words as the answer when they chose no option", () => {
    // Act
    const body = answerMessage([question({ question: "Which?" })], { answers: [{ labels: [], text: "neither" }] });

    // Assert
    expect(body).toBe("Answering your question.\n\nWhich?\nneither");
  });

  it("should give the option and then the words when they said both", () => {
    // Act
    const body = answerMessage([question({ question: "Which?" })], { answers: [{ labels: ["One"], text: "but only for now" }] });

    // Assert
    expect(body).toBe("Answering your question.\n\nWhich?\nOne — but only for now");
  });
});
