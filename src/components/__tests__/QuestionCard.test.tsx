/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnswerQuestionAction, QuestionCard, type QuestionTone } from "@/components/questions/QuestionCard";
import type { Question } from "@/questions/questions";
import type { QuestionView } from "@/questions/views";

const ASKED_AT = "2026-10-21T10:00:03.000Z";

afterEach(cleanup);

function question(overrides: Partial<Question> = {}): Question {
  return {
    question: "Do you prefer red or blue?",
    header: "Colour",
    options: [
      { label: "Red", description: "You prefer red." },
      { label: "Blue", description: "You prefer blue." }
    ],
    multiSelect: false,
    ...overrides
  };
}

function view(overrides: Partial<QuestionView> = {}): QuestionView {
  return { id: "q-1", agentId: "agent-1", askedAt: ASKED_AT, questions: [question()], answer: null, offered: true, ...overrides };
}

function answering(result: Awaited<ReturnType<AnswerQuestionAction>> = { ok: true }) {
  return vi.fn<AnswerQuestionAction>(async () => result);
}

function card(props: { view?: QuestionView; tone?: QuestionTone; answer?: AnswerQuestionAction } = {}) {
  return <QuestionCard view={props.view ?? view()} tone={props.tone ?? "assistant"} answer={props.answer ?? answering()} />;
}

/** The card as a viewer who may see the agent but not message it gets it: no action to give it, so no controls. */
function readOnly(overrides: Partial<QuestionView> = {}) {
  return <QuestionCard view={view(overrides)} tone="hub" />;
}

describe("QuestionCard", () => {
  it("should show the header, the question and every option with its description when the question is unanswered", () => {
    // Act
    render(card());

    // Assert
    expect(screen.getByText("Colour")).toBeTruthy();
    expect(screen.getByText("Do you prefer red or blue?")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /Red/ })).toBeTruthy();
    expect(screen.getByText("You prefer blue.")).toBeTruthy();
  });

  it("should send the choice as soon as an option is pressed when one question offers one answer", async () => {
    // Arrange
    const answer = answering();
    render(card({ answer }));

    // Act
    fireEvent.click(screen.getByRole("radio", { name: /Blue/ }));

    // Assert
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ questionId: "q-1", answers: { answers: [{ labels: ["Blue"], text: null }] } }));
  });

  it("should offer checkboxes and one submit when the question allows more than one option", async () => {
    // Arrange
    const answer = answering();
    render(card({ view: view({ questions: [question({ multiSelect: true })] }), answer }));

    // Act
    fireEvent.click(screen.getByRole("checkbox", { name: /Red/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Blue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // Assert
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ questionId: "q-1", answers: { answers: [{ labels: ["Red", "Blue"], text: null }] } }));
  });

  it("should take an answer in the person's own words, since the tool always allows one", async () => {
    // Arrange
    const answer = answering();
    render(card({ answer }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "amber, actually" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // Assert
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ questionId: "q-1", answers: { answers: [{ labels: [], text: "amber, actually" }] } }));
  });

  it("should ask for every question before it will send when the assistant asked more than one", async () => {
    // Arrange
    const answer = answering();
    const two = view({
      questions: [
        question(),
        question({
          header: "Size",
          question: "How big?",
          options: [
            { label: "Small", description: "" },
            { label: "Large", description: "" }
          ]
        })
      ]
    });
    render(card({ view: two, answer }));

    // Act
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));

    // Assert
    expect(answer).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send answer" }).hasAttribute("disabled")).toBe(true);

    // Act
    fireEvent.click(screen.getByRole("radio", { name: /Large/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // Assert
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith({
        questionId: "q-1",
        answers: {
          answers: [
            { labels: ["Red"], text: null },
            { labels: ["Large"], text: null }
          ]
        }
      })
    );
  });

  it("should show the refusal and keep the choice when the answer could not be sent", async () => {
    // Arrange
    render(card({ answer: answering({ ok: false, error: "that question has already been answered" }) }));

    // Act
    fireEvent.click(screen.getByRole("radio", { name: /Red/ }));

    // Assert
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("that question has already been answered"));
    expect((screen.getByRole("radio", { name: /Red/ }) as HTMLInputElement).checked).toBe(true);
  });

  /**
   * An answer is accepted exactly once, so the card has to settle on the action's own answer rather than on the
   * page coming back with the stored one. Handing the options back would let a second press through — refused as
   * already answered — and in send-on-press mode the first, possibly mistaken, choice is already what the session
   * received. The redraw rides on the `agent_question` event, so a card that waited for it would never settle with
   * the stream down.
   */
  it("should settle on what it sent, without the page coming back, once the answer was accepted", async () => {
    // Arrange
    const answer = answering();
    render(card({ answer }));

    // Act
    fireEvent.click(screen.getByRole("radio", { name: /Blue/ }));

    // Assert
    await waitFor(() => expect(screen.getByRole("region", { name: "A question the assistant asked" })).toBeTruthy());
    expect(screen.getByText("Blue")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("should settle on a submitted answer of the person's own words as well", async () => {
    // Arrange
    render(card({ answer: answering() }));

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Something else" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "amber" } });
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));

    // Assert
    await waitFor(() => expect(screen.getByText("amber")).toBeTruthy());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  /**
   * A question nobody answered inside the window it was offered for. The card still says what was asked — the
   * thread must not lose that — and offers nothing, because the turn that asked is long over.
   */
  it("should show what was asked and offer nothing once the question is no longer being waited on", () => {
    // Act
    render(card({ view: view({ offered: false }) }));

    // Assert
    expect(screen.getByText("Do you prefer red or blue?")).toBeTruthy();
    expect(screen.getByText("This question was not answered, and the assistant is no longer waiting.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should show what was chosen and offer nothing once the question has been answered", () => {
    // Act
    render(card({ view: view({ answer: { answers: [{ labels: ["Red"], text: null }], at: ASKED_AT } }) }));

    // Assert
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should show the option and the words together when the person said both", () => {
    // Act
    render(card({ view: view({ answer: { answers: [{ labels: ["Red"], text: "but only for now" }], at: ASKED_AT } }) }));

    // Assert
    expect(screen.getByText("Red — but only for now")).toBeTruthy();
  });

  /**
   * A viewer with a read grant is offered nothing: the action would refuse them, and its refusal says the question
   * is no longer waiting for an answer, which is not true. The question and its options are still shown, because
   * they are transcript-grade content a reader may see.
   */
  it("should offer no controls, and say what is being waited on, when there is no action to answer with", () => {
    // Act
    render(readOnly());

    // Assert
    expect(screen.getByText("Do you prefer red or blue?")).toBeTruthy();
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.getByText("Waiting for an answer from the owner.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("should show the answer and no controls to a reader once the owner has answered", () => {
    // Act
    render(readOnly({ answer: { answers: [{ labels: ["Red"], text: null }], at: ASKED_AT } }));

    // Assert
    expect(screen.getByText("Red")).toBeTruthy();
    expect(screen.queryByText("Waiting for an answer from the owner.")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("should name itself as the assistant's question rather than theirs when it is not theirs to answer", () => {
    // Act
    render(readOnly());

    // Assert
    expect(screen.getByRole("region", { name: "A question the assistant asked" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "A question for you" })).toBeNull();
  });

  /**
   * An answered row whose stored answer this version cannot read arrives with an empty `answers`. It must not go
   * back to offering a choice: the question already has an answer, so every press would be refused.
   */
  it("should say it was answered, without saying what was chosen, when the answer cannot be read", () => {
    // Act
    render(card({ view: view({ answer: { answers: [], at: ASKED_AT } }) }));

    // Assert
    expect(screen.getByText("Answered, though what was chosen cannot be shown.")).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each<QuestionTone>(["assistant", "hub"])("should name itself for a screen reader in the %s theme", (tone) => {
    // Act
    render(card({ tone }));

    // Assert
    expect(screen.getByRole("region", { name: "A question for you" })).toBeTruthy();
  });

  it("should name itself in the plural when more than one question was asked", () => {
    // Act
    render(card({ view: view({ questions: [question(), question({ header: "Size" })] }) }));

    // Assert
    expect(screen.getByRole("region", { name: "Questions for you" })).toBeTruthy();
  });
});
