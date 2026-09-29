import { describe, expect, it, vi } from "vitest";
import { AccessDenied } from "../access/load.ts";
import { HttpError } from "../agent-api/http.ts";
import { InvalidTopics } from "../topics/slug.ts";
import { NotSignedIn } from "../viewer/identity.ts";
import { refusalMessage, runAction, text } from "./action.ts";

describe("refusalMessage", () => {
  it.each([
    ["an HTTP refusal", new HttpError(403, "not yours")],
    ["an invalid topic", new InvalidTopics("bad topic")],
    ["a refused grant", new AccessDenied("not known")]
  ])("should pass on the message of %s", (_label, error) => {
    expect(refusalMessage(error)).toBe(error.message);
  });

  it("should tell a signed-out person to reload when the session has gone", () => {
    expect(refusalMessage(new NotSignedIn("x"))).toContain("reload");
  });

  it("should keep an unexpected fault out of the message when it is not a refusal", () => {
    expect(refusalMessage(new Error("connection refused at 10.0.0.1"))).toBeUndefined();
  });
});

describe("runAction", () => {
  it("should return what the work returns when it succeeds", async () => {
    expect(await runAction("test", async () => ({ ok: true as const, id: "1" }))).toEqual({ ok: true, id: "1" });
  });

  it("should turn a refusal into a message when the work throws one", async () => {
    expect(
      await runAction("test", async () => {
        throw new HttpError(404, "no such agent");
      })
    ).toEqual({ ok: false, error: "no such agent" });
  });

  it("should log a fault and show a generic message when the work fails unexpectedly", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await runAction("test", async () => {
      throw "boom";
    });

    expect(result).toEqual({ ok: false, error: "something went wrong on our side; try again" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("the test action failed: boom"));
    error.mockRestore();
  });

  it("should log the stack of an unexpected Error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runAction("test", async () => {
      throw new Error("kaput");
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("kaput"));
    error.mockRestore();
  });
});

describe("text", () => {
  it("should trim a string and read anything else as empty", () => {
    expect(text("  a  ")).toBe("a");
    expect(text(null)).toBe("");
    expect(text(new Blob(["x"]))).toBe("");
  });
});
