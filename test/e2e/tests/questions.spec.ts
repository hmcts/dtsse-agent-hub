import { expect, type Page, test } from "@playwright/test";
import { askQuestion, asPersona, chatPersona, connectForChat, dismissGettingReady, openLocalChat, readAgentStream, registerAgent, unique } from "./hub";

/**
 * A question a session asked with `AskUserQuestion`, which the client intercepted because nobody is at its keyboard.
 * The owner reads it in the session's chat in the Assistant and answers it, and the answer goes to the agent as an
 * ordinary message — which is what this watches for, on the agent's own stream, since it is the whole point of
 * intercepting the tool.
 *
 * The session is one on the person's own computer, because that chat needs no pod: see `local-chats.spec.ts` for
 * what that is and for why these skip on preview and AAT.
 */

const CANNOT_REGISTER = "this deployment checks real agent tokens, so the suite cannot register an agent";
const ASSISTANT_OFF = "the Assistant runs on a virtual agent, which is off on this deployment";

/**
 * The card while it is still asking, and the card once it is answered. They are two different regions: the
 * accessible name changes with the state, because "A question for you" stops being true the moment there is nothing
 * left to answer. A locator that kept the first name would resolve to nothing after the answer and every assertion
 * through it would read as a pass until one of them waited for something.
 */
const asking = (page: Page) => page.getByRole("region", { name: "A question for you" });
const asked = (page: Page) => page.getByRole("region", { name: "A question the assistant asked" });

test.describe("questions @regression", () => {
  test("should offer the options in the session's chat and send the choice as a message @regression", async ({ browser, baseURL, request }) => {
    // The agent's stream is read to its end: see `readAgentStream`.
    test.setTimeout(150_000);
    const persona = chatPersona("question");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, persona);
    await askQuestion(request, persona, agent!, {
      question: "Do you prefer red or blue?",
      header: "Colour",
      options: [
        { label: "Red", description: "You prefer red." },
        { label: "Blue", description: "You prefer blue." }
      ]
    });

    const owner = await asPersona(browser, persona, baseURL!);
    try {
      const page = await owner.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      await expect(asking(page).getByText("Do you prefer red or blue?")).toBeVisible();
      await expect(asking(page).getByText("You prefer blue.")).toBeVisible();

      await asking(page).getByRole("radio", { name: /Red/ }).click();

      // Once answered the card says what was chosen and offers nothing. It settles on the action's own answer rather
      // than on the page coming back, so this does not wait on the stream.
      await expect(asked(page)).toBeVisible();
      await expect(asked(page).getByText("Red", { exact: true })).toBeVisible();
      await expect(asking(page)).toHaveCount(0);
      await expect(asked(page).getByRole("radio")).toHaveCount(0);
      await expect(asked(page).getByRole("button")).toHaveCount(0);
      // The answer quotes the question back, so the session does not have to go looking for it.
      const stream = await readAgentStream(request, persona, agent!);
      expect(stream).toContain("Answering your question.");
      expect(stream).toContain("Do you prefer red or blue?");
    } finally {
      await owner.close();
    }
  });

  test("should let the owner answer in their own words instead @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("question-words");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, persona);
    await askQuestion(request, persona, agent!, {
      question: "Which environment?",
      header: "Env",
      options: [
        { label: "AAT", description: "The shared test environment." },
        { label: "Demo", description: "The demo environment." }
      ]
    });

    const owner = await asPersona(browser, persona, baseURL!);
    try {
      const page = await owner.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      await asking(page).getByRole("button", { name: "Something else" }).click();
      await asking(page).getByRole("textbox").fill("perftest, please");
      await asking(page).getByRole("button", { name: "Send answer" }).click();

      await expect(asked(page).getByText("perftest, please")).toBeVisible({ timeout: 15_000 });
    } finally {
      await owner.close();
    }
  });
});
