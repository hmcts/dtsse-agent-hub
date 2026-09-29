import { expect, test } from "@playwright/test";

test.describe("health @smoke", () => {
  test("should answer /health with UP @smoke @regression", async ({ request }) => {
    const response = await request.get("/health");

    expect(response.status()).toBe(200);
    expect(((await response.json()) as { status?: string }).status).toBe("UP");
  });
});
