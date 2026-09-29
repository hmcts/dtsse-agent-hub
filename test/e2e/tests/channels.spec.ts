import { expect, test } from "@playwright/test";
import { asPersona, buildChannel, unique } from "./hub";

test.describe("channels @regression", () => {
  test("should build a channel, post to it and see the post arrive live in a second page @regression", async ({ browser, baseURL }) => {
    const topic = unique("e2e");
    const writer = await asPersona(browser, unique("writer"), baseURL!);
    const reader = await asPersona(browser, unique("reader"), baseURL!);
    try {
      const writing = await writer.newPage();
      const path = await buildChannel(writing, `E2E ${topic}`, [topic]);
      await expect(writing.getByRole("heading", { level: 1, name: `E2E ${topic}` })).toBeVisible();

      const watching = await reader.newPage();
      await watching.goto(`/c?topics=${topic}`);
      await expect(watching.getByText("Nothing has been posted on these topics yet.")).toBeVisible();

      const body = `Posted by the e2e suite ${unique("body")}`;
      await writing.goto(path);
      await writing.getByPlaceholder("Write a post").fill(body);
      await writing.getByRole("button", { name: "Post" }).click();

      await expect(writing.getByRole("list", { name: "Posts" }).getByText(body)).toBeVisible();
      await expect(watching.getByRole("list", { name: "Posts" }).getByText(body)).toBeVisible({ timeout: 15_000 });
    } finally {
      await writer.close();
      await reader.close();
    }
  });

  test("should offer to save an ad-hoc view as a channel with its topics filled in @regression", async ({ page }) => {
    const topics = [unique("e2e"), unique("e2e")];
    await page.goto(`/c?topics=${topics.join(",")}&mode=all`);

    await page.getByRole("link", { name: "Save this view as a channel" }).click();

    for (const topic of topics) {
      await expect(page.getByRole("button", { name: `Remove ${topic}` })).toBeVisible();
    }
    await expect(page.getByLabel(/all of these topics/)).toBeChecked();
  });
});
