import { describe, expect, it } from "vitest";
import { loadNotify, TOOLS_MISSING } from "./notify-tools.ts";

const missing = (message: string): Error => Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });

describe("loadNotify", () => {
  it("should load the Notify module when the package is installed", async () => {
    const notify = await loadNotify();
    expect(typeof notify.listNotifyTemplates).toBe("function");
  });

  it("should answer tools_missing with how to install it when the package is not installed", async () => {
    await expect(loadNotify(() => Promise.reject(missing("Cannot find package '@hmcts-cft/docmosis-tools' imported from x")))).rejects.toMatchObject({
      code: "tools_missing",
      detail: TOOLS_MISSING
    });
  });

  it("should pass on any other failure to load", async () => {
    await expect(loadNotify(() => Promise.reject(missing("Cannot find module './other.js'")))).rejects.toThrow("other.js");
    await expect(loadNotify(() => Promise.reject(new SyntaxError("bad")))).rejects.toThrow("bad");
    await expect(loadNotify(() => Promise.reject(null))).rejects.toBeNull();
  });
});
