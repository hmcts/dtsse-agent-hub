import { expect, test } from "@playwright/test";
import { asPersona, registerAgent, unique } from "./hub";

test.describe("direct messages @regression", () => {
  test("should hide the composer from a read grantee and show it to the owner @regression", async ({ browser, baseURL, request }) => {
    const ownerPersona = unique("owner");
    const viewerPersona = unique("viewer");
    const agent = await registerAgent(request, ownerPersona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");

    const owner = await asPersona(browser, ownerPersona, baseURL!);
    const viewer = await asPersona(browser, viewerPersona, baseURL!);
    try {
      const viewing = await viewer.newPage();
      // Visiting once makes the viewer a known person, which a grant needs.
      await viewing.goto(`/agents/${agent}`);
      await expect(viewing.getByRole("heading", { name: "Not found" })).toBeVisible();

      const owning = await owner.newPage();
      await owning.goto("/access");
      await owning.getByLabel("Their email address").fill(`${viewerPersona}@dev.invalid`);
      await owning.getByRole("button", { name: "Grant" }).click();
      await expect(owning.getByRole("status")).toContainText("now has read access");

      await viewing.goto(`/agents/${agent}`);
      await expect(viewing.getByText("You have read access to this agent.")).toBeVisible();
      await expect(viewing.getByRole("form", { name: "Message this agent" })).toHaveCount(0);

      await owning.goto(`/agents/${agent}`);
      const message = `hello from the e2e suite ${unique("dm")}`;
      await owning.getByRole("textbox", { name: "Message this agent" }).fill(message);
      await owning.getByRole("button", { name: "Send" }).click();
      await expect(owning.getByRole("list", { name: "Direct messages" }).getByText(message)).toBeVisible();

      await expect(viewing.getByRole("list", { name: "Direct messages" }).getByText(message)).toBeVisible({ timeout: 15_000 });
    } finally {
      await owner.close();
      await viewer.close();
    }
  });
});
