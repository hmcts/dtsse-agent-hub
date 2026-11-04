import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PREPARE_TIMEOUT_MS, prepareBundled, prepareEach, readyWithin, reason, safeSay } from "./plugin-deps.ts";

const WS = "/workspace/cft-workspace";
const install = (name: string) => `/workspace/.agent-hub-plugins/${name}-0123456789ab`;
const ok = () => vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

describe("prepareBundled", () => {
  it("should run the pod's copy of scripts/slides deps when slides is not ticked", async () => {
    const run = ok();
    await prepareBundled("slides", { run, env: { AGENT_HUB_PLUGINS: "pcs", HOME: "/home/agent" }, workspace: WS, install });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(join(install("slides"), "scripts", "slides"), ["deps"], {
      env: expect.objectContaining({ HOME: "/home/agent" }),
      timeoutMs: PREPARE_TIMEOUT_MS
    });
  });

  it("should run nothing and make no copy when welsh is not ticked", async () => {
    const run = ok();
    const copy = vi.fn(install);
    await prepareBundled("welsh", { run, env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install: copy });
    expect(run).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("should say rather than throw when the install exits non-zero", async () => {
    const said: string[] = [];
    const run = vi.fn(async () => ({ code: 1, stdout: "", stderr: "npm ERR! network\n" }));
    await expect(
      prepareBundled("slides", { run, env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install, say: (m) => said.push(m) })
    ).resolves.toBeUndefined();
    expect(said).toEqual(["slides: could not install the tools' dependencies (exit 1): npm ERR! network"]);
  });

  it("should say rather than throw when the copy or the run itself fails", async () => {
    const said: string[] = [];
    const run = vi.fn(async () => {
      throw new Error("spawn ENOENT");
    });
    await expect(
      prepareBundled("slides", { run, env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install, say: (m) => said.push(m) })
    ).resolves.toBeUndefined();
    const copyFails = () => {
      throw new Error("ENOSPC");
    };
    await expect(
      prepareBundled("slides", { run: ok(), env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install: copyFails, say: (m) => said.push(m) })
    ).resolves.toBeUndefined();
    expect(said).toEqual(["slides: could not prepare the tools: spawn ENOENT", "slides: could not prepare the tools: ENOSPC"]);
  });
});

describe("prepareEach", () => {
  it("should start each plugin's install only once the one before it has finished", async () => {
    const started: string[] = [];
    let finishFirst = () => {};
    const run = vi.fn(async (cmd: string) => {
      started.push(cmd);
      if (started.length === 1) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const done = Promise.all(prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install }).values());
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toEqual([join(install("welsh"), "scripts", "welsh")]);
    finishFirst();
    await done;
    expect(started).toEqual([join(install("welsh"), "scripts", "welsh"), join(install("slides"), "scripts", "slides")]);
  });

  it("should start no further install once the signal has aborted", async () => {
    const stop = new AbortController();
    const run = vi.fn(async () => {
      stop.abort();
      return { code: 0, stdout: "", stderr: "" };
    });
    await Promise.all(prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install }, stop.signal).values());
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(join(install("welsh"), "scripts", "welsh"), ["deps"], expect.anything());
  });

  it("should start nothing when the signal has aborted before it begins", async () => {
    const run = ok();
    const copy = vi.fn(install);
    await Promise.all(prepareEach(["slides"], { run, env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install: copy }, AbortSignal.abort()).values());
    expect(run).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("should go on to the next plugin when one's install fails", async () => {
    const said: string[] = [];
    const run = vi.fn(async (cmd: string) => ({ code: cmd.endsWith("welsh") ? 1 : 0, stdout: "", stderr: "npm ERR! network" }));
    await Promise.all(
      prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install, say: (m) => said.push(m) }).values()
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(said).toEqual(["welsh: could not install the tools' dependencies (exit 1): npm ERR! network"]);
  });

  it("should settle each plugin's promise once its own install has finished, before the next one's", async () => {
    let finishSlides = () => {};
    const run = vi.fn(async (cmd: string) => {
      if (cmd.endsWith("slides")) {
        await new Promise<void>((resolve) => {
          finishSlides = resolve;
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const settled = prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install });
    let slidesDone = false;
    void settled.get("slides")?.then(() => {
      slidesDone = true;
    });
    await settled.get("welsh");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(slidesDone).toBe(false);
    finishSlides();
    await settled.get("slides");
    expect([...settled.keys()]).toEqual(["welsh", "slides"]);
  });
});

describe("readyWithin", () => {
  it("should be true at once when there is nothing to wait on", async () => {
    await expect(readyWithin(undefined, 0)).resolves.toBe(true);
  });

  it("should be true once the install settles inside the time, and false when it does not", async () => {
    await expect(readyWithin(Promise.resolve(), 1000)).resolves.toBe(true);
    await expect(readyWithin(new Promise<void>(() => {}), 10)).resolves.toBe(false);
  });
});

describe("safeSay", () => {
  it("should pass each message on to the logger it wraps", () => {
    const say = vi.fn();
    safeSay(say)("hello");
    expect(say).toHaveBeenCalledWith("hello");
  });

  it("should not throw when the logger it wraps throws, or when there is none", () => {
    const say = vi.fn(() => {
      throw new Error("logger broke");
    });
    expect(() => safeSay(say)("hello")).not.toThrow();
    expect(() => safeSay(undefined)("hello")).not.toThrow();
  });
});

describe("reason", () => {
  it("should give an error's message, and anything else thrown as text", () => {
    expect(reason(new Error("boom"))).toBe("boom");
    expect(reason("plain")).toBe("plain");
    expect(reason(42)).toBe("42");
  });
});
