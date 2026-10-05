import { describe, expect, it } from "vitest";
import { checkPort, exposeRefusal, publicHost, publicUrl, withoutPort, withPort } from "./ports.ts";

describe("checkPort", () => {
  it.each([
    ["1024", 1024],
    [" 3000 ", 3000],
    [65535, 65535]
  ] as const)("should accept %j", (raw, port) => {
    expect(checkPort(raw)).toEqual({ ok: true, port });
  });

  it.each(["1023", "65536", "80", "3000.5", "-3000", "", "abc", "123456", null])("should refuse %j", (raw) => {
    expect(checkPort(raw)).toEqual({ ok: false, error: "a port is a whole number from 1024 to 65535" });
  });
});

describe("exposeRefusal", () => {
  it("should allow a new port when there is room", () => {
    expect(exposeRefusal([3000, 8080], 5173)).toBeUndefined();
  });

  it("should refuse a port that is already exposed", () => {
    expect(exposeRefusal([3000], 3000)).toBe("port 3000 is already exposed");
  });

  it("should refuse a fourth port", () => {
    expect(exposeRefusal([3000, 4000, 5000], 6000)).toBe("a virtual agent can expose at most 3 ports; remove one first");
  });
});

describe("withPort and withoutPort", () => {
  it("should keep the ports ascending when one is added", () => {
    expect(withPort([3000, 8080], 5173)).toEqual([3000, 5173, 8080]);
  });

  it("should drop only the port named when one is removed", () => {
    expect(withoutPort([3000, 5173, 8080], 5173)).toEqual([3000, 8080]);
  });
});

describe("publicHost and publicUrl", () => {
  it("should serve each port at the StatefulSet's name and the port under the domain", () => {
    expect(publicHost("va-0f8a6a1e", 3000, "preview.platform.hmcts.net")).toBe("va-0f8a6a1e-3000.preview.platform.hmcts.net");
    expect(publicUrl("va-0f8a6a1e", 3000, "example.net")).toBe("https://va-0f8a6a1e-3000.example.net");
  });
});
