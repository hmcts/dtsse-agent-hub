import { afterEach, describe, expect, it, vi } from "vitest";
import { realtime } from "./process.ts";
import { startRealtime } from "./start.ts";

vi.mock("./process.ts", () => ({ realtime: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("startRealtime", () => {
  it("should start the process-wide realtime when given no loader", async () => {
    await startRealtime();

    expect(realtime).toHaveBeenCalledOnce();
  });

  it("should start the pod's realtime once it has loaded", async () => {
    const realtime = vi.fn();

    await startRealtime(async () => ({ realtime }));

    expect(realtime).toHaveBeenCalledOnce();
  });

  it.each([new Error("no database url"), "no database url"])("should log and carry on booting when starting throws %s", async (thrown) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await startRealtime(async () => ({
      realtime: () => {
        throw thrown;
      }
    }));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no database url"));
  });
});
