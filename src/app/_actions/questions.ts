"use server";

import { grantsHeldBy } from "@/access/load";
import { canPersonMessageAgent } from "@/access/rules";
import { sendToConversation } from "@/assistant/send";
import { findConversation } from "@/assistant/store";
import { directAsPerson } from "@/messages/send";
import { answerMessage, checkAnswer, storedQuestions } from "@/questions/questions";
import { findQuestion, recordAnswer } from "@/questions/store";
import { prisma } from "@/store/prisma";
import { requireViewer } from "@/viewer/current";
import { type ActionResult, runAction, text } from "@/web/action";

/**
 * The person's answer to a question their agent's session asked with `AskUserQuestion`.
 *
 * It goes back as an ordinary direct message, so the wake, the delivery and the thread all work exactly as they do
 * for anything they type — the tool call it came from was denied in the pod and the session's turn is long over,
 * which is the whole point of intercepting it. The answer is recorded in that message's own transaction, so a card
 * never shows an answer that was not delivered and a question is never answered twice.
 */

/** The same answer for a question that never existed and one the viewer may not answer: an id is not worth confirming. */
const MISSING: { ok: false; error: string } = { ok: false, error: "that question is no longer waiting for an answer" };

export async function answerAgentQuestion(input: { questionId: unknown; answers: unknown }): Promise<ActionResult> {
  return await runAction("answer question", async () => {
    const viewer = await requireViewer();
    const question = await findQuestion(prisma, text(input.questionId));
    if (question === undefined) {
      return MISSING;
    }
    const { agent } = question;
    const grants = await grantsHeldBy(prisma, viewer.oid);
    // The rule, rather than a check of its own: answering is sending, so whoever may message the agent may answer
    // its question, and a conversation's agent is `ownerOnly` so no grant reaches one of those.
    if (!canPersonMessageAgent(viewer.oid, { ...agent, ownerOnly: agent.assistantConversationId !== null }, grants)) {
      return MISSING;
    }
    if (question.answeredAt !== null) {
      return { ok: false, error: "that question has already been answered" };
    }
    const questions = storedQuestions(question.questions);
    if (questions.length === 0) {
      return MISSING;
    }
    const checked = checkAnswer(questions, input.answers);
    if (!checked.ok) {
      return checked;
    }
    const body = answerMessage(questions, checked.answer);
    const record = async (tx: Parameters<typeof recordAnswer>[0], messageId: bigint) => {
      await recordAnswer(tx, question, checked.answer, messageId);
    };
    const conversation = agent.assistantConversationId === null ? undefined : await findConversation(prisma, viewer.oid, agent.assistantConversationId);
    if (conversation !== undefined) {
      // The same path the composer's send takes, so the conversation is touched and a stopped assistant is woken.
      await sendToConversation(prisma, viewer.oid, conversation, { body, title: body, alongside: record });
    } else {
      await directAsPerson(prisma, viewer.oid, agent.id, body, record);
    }
    return { ok: true };
  });
}
