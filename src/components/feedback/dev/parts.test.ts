import { describe, expect, it } from "vitest";
import { ACTION_STALE_PAGE, ACTION_UNREACHABLE } from "@/web/action-fault";
import { call } from "./parts";

describe("call", () => {
  it("should answer what the action answers when it does not throw", async () => {
    expect(await call(async () => ({ ok: true as const }))).toEqual({ ok: true });
  });

  it.each([
    ["the connection failed", new Error("fetch failed"), ACTION_UNREACHABLE],
    ["a deploy replaced the page's actions", new Error('Failed to find Server Action "abc".'), ACTION_STALE_PAGE]
  ])("should say what to do when the call throws because %s", async (_when, thrown, said) => {
    expect(
      await call(async () => {
        throw thrown;
      })
    ).toEqual({ ok: false, error: said });
  });
});
