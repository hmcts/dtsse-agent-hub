import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PREPARE_TIMEOUT_MS, prepareBundled, prepareEach } from "./plugin-deps.ts";

const WS = "/workspace/cft-workspace";
const install = (name: string) => `/workspace/.agent-hub-plugins/${name}-0123456789ab`;
const ok = () => vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));

describe("prepareBundled", () => {
  it("should run the pod's copy of scripts/slides deps when slides is ticked", async () => {
    const run = ok();
    await prepareBundled("slides", { run, env: { AGENT_HUB_PLUGINS: "pcs,slides", HOME: "/home/agent" }, workspace: WS, install });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(join(install("slides"), "scripts", "slides"), ["deps"], {
      env: expect.objectContaining({ HOME: "/home/agent" }),
      timeoutMs: PREPARE_TIMEOUT_MS
    });
  });

  it("should run nothing and make no copy when slides is not ticked", async () => {
    const run = ok();
    const copy = vi.fn(install);
    await prepareBundled("slides", { run, env: { AGENT_HUB_PLUGINS: "welsh" }, workspace: WS, install: copy });
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
    const done = prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install });
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
    await prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install }, stop.signal);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(join(install("welsh"), "scripts", "welsh"), ["deps"], expect.anything());
  });

  it("should start nothing when the signal has aborted before it begins", async () => {
    const run = ok();
    const copy = vi.fn(install);
    await prepareEach(["slides"], { run, env: { AGENT_HUB_PLUGINS: "slides" }, workspace: WS, install: copy }, AbortSignal.abort());
    expect(run).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("should go on to the next plugin when one's install fails", async () => {
    const said: string[] = [];
    const run = vi.fn(async (cmd: string) => ({ code: cmd.endsWith("welsh") ? 1 : 0, stdout: "", stderr: "npm ERR! network" }));
    await prepareEach(["welsh", "slides"], { run, env: { AGENT_HUB_PLUGINS: "welsh,slides" }, workspace: WS, install, say: (m) => said.push(m) });
    expect(run).toHaveBeenCalledTimes(2);
    expect(said).toEqual(["welsh: could not install the tools' dependencies (exit 1): npm ERR! network"]);
  });
});
