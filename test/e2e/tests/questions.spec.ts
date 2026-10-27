import { expect, test } from "@playwright/test";
import { askQuestion, asPersona, registerAgent, unique } from "./hub";

/**
 * A question a session asked with `AskUserQuestion`, which the client intercepted because nobody is at its keyboard.
 * The owner reads it on the agent's page and answers it, and the answer goes to the agent as an ordinary message —
 * which is what this watches for, since it is the whole point of intercepting the tool.
 */
test.describe("questions @regression", () => {
  test("should offer the options on the agent's page and send the choice as a message @regression", async ({ browser, baseURL, request }) => {
    const persona = unique("owner");
    const agent = await registerAgent(request, persona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
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
      await page.goto(`/hub/agents/${agent}`);
      const card = page.getByRole("region", { name: "A question for you" });

      await expect(card.getByText("Do you prefer red or blue?")).toBeVisible();
      await expect(card.getByText("You prefer blue.")).toBeVisible();

      await card.getByRole("radio", { name: /Red/ }).click();

      // The answer quotes the question back, so the session does not have to go looking for it.
      const conversation = page.getByRole("list", { name: "Conversation" });
      await expect(conversation.getByText("Answering your question.")).toBeVisible({ timeout: 15_000 });
      // Once answered the card says what was chosen and offers nothing.
      await expect(card.getByRole("radio")).toHaveCount(0);
      await expect(card.getByText("Red", { exact: true })).toBeVisible();
    } finally {
      await owner.close();
    }
  });

  test("should let the owner answer in their own words instead @regression", async ({ browser, baseURL, request }) => {
    const persona = unique("owner");
    const agent = await registerAgent(request, persona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
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
      await page.goto(`/hub/agents/${agent}`);
      const card = page.getByRole("region", { name: "A question for you" });

      await card.getByRole("button", { name: "Something else" }).click();
      await card.getByRole("textbox").fill("perftest, please");
      await card.getByRole("button", { name: "Send answer" }).click();

      await expect(page.getByRole("list", { name: "Conversation" }).getByText("perftest, please")).toBeVisible({ timeout: 15_000 });
    } finally {
      await owner.close();
    }
  });
});
