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

  it("should answer tools_missing when the installed package is too old to have the notify exports", async () => {
    const unexported = Object.assign(
      new Error("Package subpath './notify/node' is not defined by \"exports\" in /g/node_modules/@hmcts-cft/docmosis-tools/package.json"),
      {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED"
      }
    );
    const noExport = new SyntaxError("The requested module '@hmcts-cft/docmosis-tools/notify/node' does not provide an export named 'KeyVaultError'");
    for (const failure of [unexported, noExport]) {
      await expect(loadNotify(() => Promise.reject(failure))).rejects.toMatchObject({ code: "tools_missing", detail: TOOLS_MISSING });
    }
  });

  it("should pass on any other failure to load", async () => {
    await expect(loadNotify(() => Promise.reject(missing("Cannot find module './other.js'")))).rejects.toThrow("other.js");
    await expect(loadNotify(() => Promise.reject(new SyntaxError("bad")))).rejects.toThrow("bad");
    await expect(loadNotify(() => Promise.reject(null))).rejects.toBeNull();
  });
});
