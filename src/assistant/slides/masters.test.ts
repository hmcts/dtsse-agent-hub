import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BACKGROUND_IMAGE } from "./masters.ts";

/**
 * The slides plugin builds the .pptx on the pod and the hub draws the same slides in the browser, from one geometry.
 * The hub's image never contains `packages/`, so it carries its own copy of the plugin's `masters.ts` and of the
 * title background, and this holds both copies to the plugin's.
 */
const PLUGIN = new URL("../../../packages/agent-hub/plugins/slides/scripts/slides-lib/", import.meta.url);
const PUBLIC = new URL("../../../public/assistant/slides/", import.meta.url);

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("the shared slide geometry", () => {
  it("should be byte for byte the plugin's masters.ts when the hub draws a slide", () => {
    expect(readFileSync(new URL("./masters.ts", import.meta.url), "utf8")).toBe(readFileSync(new URL("masters.ts", PLUGIN), "utf8"));
  });

  it("should serve the plugin's own title background when a title or closing slide is drawn", () => {
    const served = readFileSync(new URL(BACKGROUND_IMAGE, PUBLIC));
    expect(sha256(served)).toBe(sha256(readFileSync(new URL(`assets/${BACKGROUND_IMAGE}`, PLUGIN))));
  });
});
