import { expect, test } from "@playwright/test";
import { asPersona, registerAgent, sampleTranscript, unique, uploadTranscript } from "./hub";

test.describe("agent conversation @regression", () => {
  test("should show an uploaded transcript, and new entries as they arrive, on the agent's page @regression", async ({ browser, baseURL, request }) => {
    const ownerPersona = unique("owner");
    const agent = await registerAgent(request, ownerPersona, unique("agent"));
    test.skip(agent === undefined, "this deployment checks real agent tokens, so the suite cannot register an agent");
    const prefix = unique("t");
    expect(await uploadTranscript(request, ownerPersona, agent!, sampleTranscript(prefix))).toBe(5);
    expect(await uploadTranscript(request, ownerPersona, agent!, sampleTranscript(prefix))).toBe(0);

    const owner = await asPersona(browser, ownerPersona, baseURL!);
    try {
      const page = await owner.newPage();
      // An entry stored before the page is watching the agent is not announced to it, so the upload waits for the stream.
      const watching = page.waitForResponse((response) => response.url().includes(`/api/ui/stream?agent=${agent}`));
      await page.goto(`/agents/${agent}`);
      const conversation = page.getByRole("list", { name: "Conversation" });

      await expect(conversation.getByText("Please run the unit tests")).toBeVisible();
      await expect(conversation.getByText("truncated")).toBeVisible();
      await expect(conversation.getByText("hidden: matched secret pattern")).toBeVisible();
      await expect(conversation.locator("code", { hasText: "AKIA[0-9A-Z]{16}" })).toBeVisible();

      const failure = conversation.locator("details", { hasText: "Error" });
      await expect(failure.locator("pre")).toBeHidden();
      await failure.locator("summary").click();
      await expect(failure.locator("pre")).toContainText("1 failed");

      await watching;
      const reply = `fixed it ${unique("live")}`;
      await uploadTranscript(request, ownerPersona, agent!, [
        { key: `${prefix}:live`, role: "assistant", content: { text: reply }, occurred_at: new Date().toISOString() }
      ]);
      await expect(conversation.getByText(reply)).toBeVisible({ timeout: 15_000 });
    } finally {
      await owner.close();
    }
  });
});
