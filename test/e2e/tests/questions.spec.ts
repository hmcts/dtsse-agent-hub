import { expect, type Page, test } from "@playwright/test";
import { askQuestion, asPersona, registerAgent, unique } from "./hub";

/**
 * A question a session asked with `AskUserQuestion`, which the client intercepted because nobody is at its keyboard.
 * The owner reads it on the agent's page and answers it, and the answer goes to the agent as an ordinary message —
 * which is what this watches for, since it is the whole point of intercepting the tool.
 */

/**
 * The card while it is still asking, and the card once it is answered. They are two different regions: the
 * accessible name changes with the state, because "A question for you" stops being true the moment there is nothing
 * left to answer. A locator that kept the first name would resolve to nothing after the answer and every assertion
 * through it would read as a pass until one of them waited for something.
 */
const asking = (page: Page) => page.getByRole("region", { name: "A question for you" });
const asked = (page: Page) => page.getByRole("region", { name: "A question the assistant asked" });

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

      await expect(asking(page).getByText("Do you prefer red or blue?")).toBeVisible();
      await expect(asking(page).getByText("You prefer blue.")).toBeVisible();

      await asking(page).getByRole("radio", { name: /Red/ }).click();

      // The answer quotes the question back, so the session does not have to go looking for it.
      await expect(page.getByRole("list", { name: "Conversation" }).getByText("Answering your question.")).toBeVisible({ timeout: 15_000 });
      // Once answered the card says what was chosen and offers nothing. It settles on the action's own answer rather
      // than on the page coming back, so this does not wait on the stream.
      await expect(asked(page)).toBeVisible();
      await expect(asked(page).getByText("Red", { exact: true })).toBeVisible();
      await expect(asking(page)).toHaveCount(0);
      await expect(asked(page).getByRole("radio")).toHaveCount(0);
      await expect(asked(page).getByRole("button")).toHaveCount(0);
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

      await asking(page).getByRole("button", { name: "Something else" }).click();
      await asking(page).getByRole("textbox").fill("perftest, please");
      await asking(page).getByRole("button", { name: "Send answer" }).click();

      await expect(page.getByRole("list", { name: "Conversation" }).getByText("perftest, please")).toBeVisible({ timeout: 15_000 });
      await expect(asked(page).getByText("perftest, please")).toBeVisible();
    } finally {
      await owner.close();
    }
  });
});
