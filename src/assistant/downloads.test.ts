import { describe, expect, it } from "vitest";
import { attachmentDisposition } from "./downloads.ts";

describe("attachmentDisposition", () => {
  it("should percent-encode the four characters encodeURIComponent leaves that RFC 5987 does not allow", () => {
    expect(attachmentDisposition("Team's plan (draft) *.pptx")).toBe(
      `attachment; filename="Team's plan (draft) *.pptx"; filename*=UTF-8''Team%27s%20plan%20%28draft%29%20%2A.pptx`
    );
  });

  it("should keep the characters RFC 5987 allows, and give an ASCII stand-in for the rest, when the name has accents and quotes", () => {
    expect(attachmentDisposition('Plan "Q4" é!~.pptx')).toBe(`attachment; filename="Plan _Q4_ _!~.pptx"; filename*=UTF-8''Plan%20%22Q4%22%20%C3%A9!~.pptx`);
  });
});
