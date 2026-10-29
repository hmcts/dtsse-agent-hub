import { expect, test } from "@playwright/test";
import { asPersona, registerAgent, unique } from "./hub";

test.describe("direct messages @regression", () => {
  /**
   * An agent is its owner's: nobody else gets its page at all, so there is no read-only rendering of it to check.
   * This is the owner's own round trip — send from the page, see it land in the thread — and the refusal everyone
   * else gets, which is the same "Not found" an id that never existed gets.
   */
  test("should message an agent from its own page, and show nobody else that page @regression", async ({ browser, baseURL, request }) => {
    const ownerPersona = unique("owner");
    const viewerPersona = unique("viewer");
    const agent = await registerAgent(request, ownerPersona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");

    const owner = await asPersona(browser, ownerPersona, baseURL!);
    const viewer = await asPersona(browser, viewerPersona, baseURL!);
    try {
      const viewing = await viewer.newPage();
      await viewing.goto(`/hub/agents/${agent}`);
      await expect(viewing.getByRole("heading", { name: "Not found" })).toBeVisible();

      const owning = await owner.newPage();
      await owning.goto(`/hub/agents/${agent}`);
      await expect(owning.getByText("Owned by you")).toBeVisible();
      const message = `hello from the e2e suite ${unique("dm")}`;
      await owning.getByRole("textbox", { name: "Message this agent" }).fill(message);
      await owning.getByRole("button", { name: "Send" }).click();

      await expect(owning.getByRole("list", { name: "Conversation" }).getByText(message)).toBeVisible();

      // Still nothing, now that there is something in the thread to be kept from.
      await viewing.goto(`/hub/agents/${agent}`);
      await expect(viewing.getByRole("heading", { name: "Not found" })).toBeVisible();
    } finally {
      await owner.close();
      await viewer.close();
    }
  });
});
