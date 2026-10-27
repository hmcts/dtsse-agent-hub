import { expect, test } from "@playwright/test";
import { connectForChat, PERSONA_COOKIE, unique } from "./hub";

/** A phone, which is where the message box is tightest for room. The size the Assistant's layout is checked at. */
const PHONE = { width: 390, height: 844 };

/** Two lines of the box, which an empty one stays under however narrow the screen it was first laid out on. */
const TWO_LINES = 60;

const PERSONA = unique("asst");

test.describe("assistant @regression", () => {
  test.beforeEach(async ({ context, baseURL, request }) => {
    await context.addCookies([{ name: PERSONA_COOKIE, value: PERSONA, url: baseURL! }]);
    // Past the gate that holds the Assistant at GitHub and Claude, so there is a message box to measure.
    await connectForChat(request, PERSONA);
  });

  /**
   * An empty box is one line tall on a phone, leaving the screen to the conversation. Its height is measured against
   * its own width, and the width it mounts at is not the width it keeps: the sidebar is a column of the row until
   * the media query reports a narrow screen, which leaves the chat beside it too narrow to give the box any width at
   * all. Measured only then, the box was given the whole of the height it is allowed to hold nothing.
   */
  test("should leave the message box one line tall on a phone when there is nothing in it @regression", async ({ page }) => {
    await page.setViewportSize(PHONE);
    const response = await page.goto("/assistant");
    test.skip(response?.status() === 404, "the Assistant runs on a virtual agent, which is off on this deployment");

    const box = page.getByRole("textbox", { name: "Message" });
    await expect(box).toBeVisible();
    const { height, top } = await box.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, top: rect.top };
    });

    expect(height).toBeLessThan(TWO_LINES);
    // And it sits at the foot of the screen, which is only true while everything above it has the room.
    expect(top).toBeGreaterThan(PHONE.height * 0.75);
  });
});
