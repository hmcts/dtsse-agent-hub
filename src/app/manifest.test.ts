import { describe, expect, it } from "vitest";
import manifest from "./manifest.ts";

describe("the web app manifest", () => {
  it("should start the installed app at the Assistant, standalone, with an icon", () => {
    expect(manifest()).toMatchObject({
      name: "CFT Workspace",
      start_url: "/assistant",
      display: "standalone",
      icons: [expect.objectContaining({ src: "/assistant/icon.svg" })]
    });
  });
});
