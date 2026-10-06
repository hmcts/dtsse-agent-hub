import { describe, expect, it } from "vitest";
import { normalisePorts, publicHost, publicUrl, samePorts } from "./ports.ts";

describe("normalisePorts", () => {
  it("should list the ports ascending once each when the pod lists them in any order or twice", () => {
    expect(normalisePorts([8080, 3000, 8080, 5173])).toEqual([3000, 5173, 8080]);
  });
});

describe("samePorts", () => {
  it.each([
    [[3000, 8080], [3000, 8080], true],
    [[], [], true],
    [[3000], [3000, 8080], false],
    [[3000, 8080], [3000, 9090], false]
  ])("should compare %j with %j as %s", (left, right, same) => {
    expect(samePorts(left, right)).toBe(same);
  });
});

describe("publicHost and publicUrl", () => {
  it("should serve each port at the StatefulSet's name and the port under the domain", () => {
    expect(publicHost("va-0f8a6a1e", 3000, "preview.platform.hmcts.net")).toBe("va-0f8a6a1e-3000.preview.platform.hmcts.net");
    expect(publicUrl("va-0f8a6a1e", 3000, "example.net")).toBe("https://va-0f8a6a1e-3000.example.net");
  });
});
