// What this pod tells the hub about its own memory. The hub's half, and the wording a person reads, is in
// dtsse-agent-hub's `src/assistant/memory-report.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryReportBody } from "../api.ts";
import { CGROUP_ROOT, type MemoryFs, measureMemory, reportMemory } from "./memory.ts";

const roots: string[] = [];

/** A cgroup directory holding whichever of the four files the test names; a value of `undefined` writes none. */
function cgroup(files: Record<string, string | undefined>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-cgroup-"));
  roots.push(root);
  for (const [name, value] of Object.entries(files)) {
    if (value !== undefined) {
      fs.writeFileSync(path.join(root, name), value);
    }
  }
  return root;
}

/** A whole cgroup as a pod with an 8 GiB limit has it. */
function pod(overrides: Record<string, string | undefined> = {}): string {
  return cgroup({
    "memory.max": "8589934592\n",
    "memory.current": "3221225472\n",
    "memory.peak": "5637144576\n",
    // `anon` is not the first line, and the file carries plenty the report ignores, so the parse has to find it.
    "memory.stat": "slab 91225272\nfile 2576980378\nanon 1717986918\nkernel 117440512\n",
    ...overrides
  });
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

describe("measureMemory", () => {
  it("should read the limit, the live figure, the peak and the part it cannot reclaim off the container's own cgroup", () => {
    expect(measureMemory({ root: pod() })).toEqual({ limit_bytes: 8589934592, current_bytes: 3221225472, peak_bytes: 5637144576, anon_bytes: 1717986918 });
  });

  it("should look under the pod's cgroup mount when no root is given", () => {
    const read: string[] = [];
    const memoryFs = {
      readFileSync: (file: string) => {
        read.push(file);
        return "4096\n";
      }
    } as unknown as MemoryFs;

    measureMemory({ fs: memoryFs });

    expect(read).toEqual([
      path.join(CGROUP_ROOT, "memory.max"),
      path.join(CGROUP_ROOT, "memory.current"),
      path.join(CGROUP_ROOT, "memory.peak"),
      path.join(CGROUP_ROOT, "memory.stat")
    ]);
  });

  // A limit is what every sentence the hub writes about memory is relative to, so a container with none has nothing
  // to report rather than a figure the hub would have to invent.
  it("should report nothing when the container has no limit at all", () => {
    const said: string[] = [];

    expect(measureMemory({ root: pod({ "memory.max": "max\n" }), say: (m) => said.push(m) })).toBeUndefined();
    expect(said.join(" ")).toContain("could not read this container's memory cgroup");
  });

  it.each(["memory.max", "memory.current", "memory.peak", "memory.stat"])("should report nothing when %s is missing, as it is on cgroup v1", (missing) => {
    expect(measureMemory({ root: pod({ [missing]: undefined }) })).toBeUndefined();
  });

  // `anon` is what the hub's warning is computed from, so a `memory.stat` without it is a report the hub could not
  // say the one useful thing about -- the three other figures are not a weaker version of that.
  it.each([
    "file 2576980378\n",
    "anonymous 123\n",
    "anon\n",
    "anon notanumber\n",
    "anon -1\n"
  ])("should report nothing when memory.stat reads %j and so carries no anon", (stat) => {
    expect(measureMemory({ root: pod({ "memory.stat": stat }) })).toBeUndefined();
  });

  it.each(["", "  ", "-1", "not a number", "9007199254740993"])("should report nothing when a figure reads %j", (value) => {
    expect(measureMemory({ root: pod({ "memory.peak": value }) })).toBeUndefined();
  });

  it("should accept a zero, which is a real answer for a cgroup nothing has charged yet", () => {
    expect(measureMemory({ root: pod({ "memory.current": "0\n" }) })).toMatchObject({ current_bytes: 0 });
  });
});

describe("reportMemory", () => {
  it("should send what it measured and answer with it", async () => {
    const sent: [string, MemoryReportBody][] = [];
    const api = {
      putMemory: async (virtualId: string, body: MemoryReportBody) => {
        sent.push([virtualId, body]);
        return null;
      }
    };

    const report = await reportMemory({ api, id: "va-1", root: pod() });

    expect(report).toEqual({ limit_bytes: 8589934592, current_bytes: 3221225472, peak_bytes: 5637144576, anon_bytes: 1717986918 });
    expect(sent).toEqual([["va-1", report]]);
  });

  it("should send nothing when it could not measure", async () => {
    const putMemory = vi.fn(async () => null);

    expect(await reportMemory({ api: { putMemory }, id: "va-1", root: pod({ "memory.peak": undefined }) })).toBeUndefined();
    expect(putMemory).not.toHaveBeenCalled();
  });

  // Not retried here: the figures are re-read and re-sent on the next session change or reconcile, and `anon` is flat
  // between those, so a lost report costs a late figure rather than a wrong one. Not because anything is monotonic —
  // `anon` falls when a session ends.
  it("should say so and give up, rather than retry, when the hub refuses the report", async () => {
    const said: string[] = [];
    const api = {
      putMemory: async () => {
        throw new Error("503");
      }
    };

    expect(await reportMemory({ api, id: "va-1", root: pod(), say: (m) => said.push(m) })).toBeUndefined();
    expect(said.join(" ")).toContain("could not report this container's memory: 503");
  });
});
