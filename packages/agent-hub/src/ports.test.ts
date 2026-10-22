// Port detection from fixture /proc/net tables, the debounce, and reports to the mock hub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockHub, type MockHub } from "./__fixtures__/mock-hub.ts";
import { createApi } from "./api.ts";
import {
  addressKind,
  createDebounce,
  createPortWatcher,
  ignoredPorts,
  listeners,
  type PortsReport,
  type PortsReporter,
  parseProcNet,
  procNetDir,
  publicUrlPattern,
  readTables,
  watchPorts
} from "./ports.ts";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/proc-net", import.meta.url));
const VID = "0f8a6a1e-1234-4000-8000-000000000001";
const LAUNCH = `launch-${"p".repeat(16)}`;
const tables = () => readTables(FIXTURES);

let hub: MockHub;
let url: string;

beforeAll(async () => {
  hub = createMockHub({ launchTokens: { [LAUNCH]: { virtualId: VID, owner: { oid: "oid-owner", name: "Olive", email: "olive@example.com" } } } });
  url = await hub.listen();
});

afterAll(async () => {
  await hub.close();
});

const reports = () => (hub.virtuals.get(VID) as { ports: Record<string, unknown>[] }).ports;

function fakeApi({ fail = 0 }: { fail?: number } = {}) {
  const sent: { id: string; body: PortsReport }[] = [];
  const api: PortsReporter & { sent: typeof sent } = {
    sent,
    async putPorts(id, body) {
      if (fail > 0) {
        fail -= 1;
        throw new Error("hub down");
      }
      sent.push({ id, body });
    }
  };
  return api;
}

// One fixture-shaped tcp table per read, the last repeating once the list runs out.
function sequence(...reads: number[][]): () => string[] {
  let i = 0;
  return () => {
    const found = reads[Math.min(i, reads.length - 1)] as number[];
    i += 1;
    return [
      found
        .map((p) => `0: 00000000:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A`)
        .join("\n")
        .replace(/^/, "header\n"),
      ""
    ];
  };
}

describe("parseProcNet", () => {
  it("should read each socket of a tcp table when the header is skipped", () => {
    // Act
    const sockets = parseProcNet(fs.readFileSync(path.join(FIXTURES, "tcp"), "utf8"));

    // Assert
    expect(sockets.length).toBe(6);
    expect(sockets[0]).toEqual({ address: "00000000", port: 3000, state: "0A" });
    expect(sockets[4]).toEqual({ address: "0A00000A", port: 3001, state: "01" });
  });

  it("should read IPv6 addresses and ignore the lines it cannot parse", () => {
    // Act
    const sockets = parseProcNet(`${fs.readFileSync(path.join(FIXTURES, "tcp6"), "utf8")}garbage\n   9: nothing here\n`);

    // Assert
    expect(sockets[1]).toEqual({ address: "00000000000000000000000001000000", port: 9090, state: "0A" });
    expect(sockets.length).toBe(4);
  });
});

describe("addressKind", () => {
  it("should tell loopback from addresses a Service can reach in IPv4, IPv6 and IPv4-mapped IPv6", () => {
    // Act and assert
    expect(addressKind("00000000")).toBe("reachable");
    expect(addressKind("0A00000A")).toBe("reachable");
    expect(addressKind("0100007F")).toBe("loopback");
    // 127.0.1.1 is loopback too.
    expect(addressKind("0101007F")).toBe("loopback");
    expect(addressKind("00000000000000000000000000000000")).toBe("reachable");
    expect(addressKind("00000000000000000000000001000000")).toBe("loopback");
    expect(addressKind("0000000000000000FFFF00000100007F")).toBe("loopback");
    expect(addressKind("0000000000000000FFFF00000A00000A")).toBe("reachable");
    expect(addressKind("B80D0120000000000000000001000000")).toBe("reachable");
  });
});

describe("listeners", () => {
  it("should report LISTEN sockets from 1024 up as open on any non-loopback address and loopback-only otherwise", () => {
    // Act and assert
    expect(listeners(tables())).toEqual({ open: [3000, 4000, 8080], local: [5173, 8081, 9090] });
  });

  it("should count a port as open when it is on both 0.0.0.0 and 127.0.0.1", () => {
    // Act
    const { open, local } = listeners(tables());

    // Assert
    expect(open.includes(3000)).toBe(true);
    expect(local.includes(3000)).toBe(false);
  });

  it("should never report a port named by VIRTUAL_AGENT_IGNORE_PORTS", () => {
    // Arrange
    const ignore = ignoredPorts({ VIRTUAL_AGENT_IGNORE_PORTS: "4000, 9090 x" });

    // Act and assert
    expect([...ignore]).toEqual([4000, 9090]);
    expect(listeners(tables(), ignore)).toEqual({ open: [3000, 8080], local: [5173, 8081] });
    expect([...ignoredPorts({})]).toEqual([]);
  });
});

describe("procNetDir", () => {
  it("should use /proc/net when the environment names no other directory", () => {
    // Act and assert
    expect(procNetDir({})).toBe("/proc/net");
    expect(procNetDir({ AGENT_HUB_PROC_NET: FIXTURES })).toBe(FIXTURES);
  });
});

describe("readTables", () => {
  it("should count a table it cannot read as empty", () => {
    // Arrange
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-net-"));
    fs.copyFileSync(path.join(FIXTURES, "tcp"), path.join(dir, "tcp"));

    // Act
    const read = readTables(dir);

    // Assert
    expect(read[1]).toBe("");
    expect(listeners(read)).toEqual({ open: [3000, 4000], local: [5173] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("createDebounce", () => {
  it("should show a port once it has been seen on 2 reads in a row and never from one sighting", () => {
    // Arrange
    const step = createDebounce();

    // Act and assert
    expect(step([3000, 5173])).toEqual([]);
    expect(step([3000])).toEqual([3000]);
    expect(step([3000, 5173])).toEqual([3000]);
    expect(step([3000, 5173])).toEqual([3000, 5173]);
  });

  it("should drop a port once it has been missing from 3 reads in a row, so a restart keeps it", () => {
    // Arrange
    const step = createDebounce();
    step([8080]);
    step([8080]);

    // Act and assert
    expect(step([])).toEqual([8080]);
    expect(step([])).toEqual([8080]);
    // Back before the third miss.
    expect(step([8080])).toEqual([8080]);
    expect(step([])).toEqual([8080]);
    expect(step([])).toEqual([8080]);
    expect(step([])).toEqual([]);
  });
});

describe("createPortWatcher", () => {
  it("should report nothing while the debounce settles and then the settled set once", async () => {
    // Arrange
    const api = fakeApi();
    const tick = createPortWatcher({ api, id: VID, read: sequence([3000]) });

    // Act and assert
    expect(await tick()).toBe("settling");
    expect(await tick()).toBe("settling");
    expect(await tick()).toBe("reported");
    expect(api.sent).toEqual([{ id: VID, body: { ports: [3000], local_only: [] } }]);
    expect(await tick()).toBe("unchanged");
    expect(await tick()).toBe("unchanged");
    expect(api.sent.length).toBe(1);
  });

  it("should report an empty set after settling, so a fresh pod clears what an earlier one left", async () => {
    // Arrange
    const api = fakeApi();
    const tick = createPortWatcher({ api, id: VID, read: sequence([]) });

    // Act
    for (let i = 0; i < 3; i++) {
      await tick();
    }

    // Assert
    expect(api.sent.map((s) => s.body)).toEqual([{ ports: [], local_only: [] }]);
  });

  it("should report only when the debounced set changes", async () => {
    // Arrange
    const api = fakeApi();
    const tick = createPortWatcher({
      api,
      id: VID,
      read: sequence([3000], [3000], [3000], [3000, 8080], [3000, 8080], [3000, 8080], [8080], [8080], [8080], [8080])
    });

    // Act
    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(await tick());
    }

    // Assert
    expect(results).toEqual(["settling", "settling", "reported", "unchanged", "reported", "unchanged", "unchanged", "unchanged", "reported", "unchanged"]);
    expect(api.sent.map((s) => s.body.ports)).toEqual([[3000], [3000, 8080], [8080]]);
  });

  it("should try a failed report again on the next read", async () => {
    // Arrange
    const api = fakeApi({ fail: 1 });
    const said: string[] = [];
    const tick = createPortWatcher({ api, id: VID, read: sequence([3000]), say: (m) => said.push(m) });

    // Act
    await tick();
    await tick();

    // Assert
    expect(await tick()).toBe("error");
    expect(await tick()).toBe("reported");
    expect(api.sent.map((s) => s.body.ports)).toEqual([[3000]]);
    expect(said[0]).toMatch(/failed: hub down/);
  });

  it("should report the lowest 10 and say so once when more than 10 ports are listening", async () => {
    // Arrange
    const api = fakeApi();
    const said: string[] = [];
    const many = Array.from({ length: 12 }, (_, i) => 3000 + i);
    const tick = createPortWatcher({ api, id: VID, read: sequence(many), say: (m) => said.push(m) });

    // Act
    for (let i = 0; i < 5; i++) {
      await tick();
    }

    // Assert
    expect((api.sent[0] as { body: PortsReport }).body.ports).toEqual(many.slice(0, 10));
    expect(said.filter((m) => /more than 10/.test(m)).length).toBe(1);
  });

  it("should read the host's own /proc/net when the caller passes no reader", async () => {
    // Arrange
    const api = fakeApi();
    const tick = createPortWatcher({ api, id: VID });

    // Act and assert: a kernel table this process cannot read counts as empty, so this never throws.
    expect(await tick()).toBe("settling");
  });

  it("should PUT /api/virtual/{id}/ports with the launch token when it reports to the hub", async () => {
    // Arrange
    const api = createApi({ env: {}, baseUrl: url, launchToken: LAUNCH });
    const tick = createPortWatcher({ api, id: VID, read: tables });

    // Act
    for (let i = 0; i < 3; i++) {
      await tick();
    }

    // Assert
    expect(reports().at(-1)).toEqual({ ports: [3000, 4000, 8080], local_only: [5173, 8081, 9090] });
    const call = hub.calls.filter((c) => c.path === `/api/virtual/${VID}/ports`).at(-1);
    expect(call?.method).toBe("PUT");
    expect(call?.headers.authorization).toBe(`Bearer ${LAUNCH}`);
  });
});

describe("watchPorts", () => {
  it("should report what AGENT_HUB_PROC_NET holds and stop on SIGTERM", async () => {
    // Arrange
    const api = fakeApi();
    const said: string[] = [];
    const env = { AGENT_HUB_PROC_NET: FIXTURES, AGENT_HUB_PORTS_MS: "1", VIRTUAL_AGENT_IGNORE_PORTS: "4000" };
    const listenersBefore = process.listenerCount("SIGTERM");

    // Act
    const running = watchPorts({ api, id: VID, env, say: (m) => said.push(m) });
    await expect.poll(() => api.sent.length).toBe(1);
    process.emit("SIGTERM");
    await running;

    // Assert: one report, not one per read.
    expect(api.sent.map((s) => s.body)).toEqual([{ ports: [3000, 8080], local_only: [5173, 8081, 9090] }]);
    expect(said.at(-1)).toMatch(/ports: reported 3000, 8080; on 127\.0\.0\.1 only: 5173, 8081, 9090/);
    expect(process.listenerCount("SIGTERM")).toBe(listenersBefore);
  });

  it("should fall back to the default interval and stop on SIGINT when the environment names no interval", async () => {
    // Arrange: an unreadable interval leaves PORTS_POLL_MS, so the loop parks until the signal wakes it.
    const api = fakeApi();
    const env = { AGENT_HUB_PROC_NET: FIXTURES, AGENT_HUB_PORTS_MS: "every-so-often" };

    // Act
    const running = watchPorts({ api, id: VID, env });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit("SIGINT");
    await running;

    // Assert: the first tick is still settling, so nothing was reported inside one interval.
    expect(api.sent).toEqual([]);
  });
});

describe("publicUrlPattern", () => {
  it("should name va-<first 8 of the id>-<port> under the domain, preview by default", () => {
    // Act and assert
    expect(publicUrlPattern({ AGENT_HUB_VIRTUAL_AGENT_ID: VID })).toBe("https://va-0f8a6a1e-<port>.preview.platform.hmcts.net");
    expect(publicUrlPattern({ AGENT_HUB_VIRTUAL_AGENT_ID: VID, VIRTUAL_AGENT_PUBLIC_DOMAIN: "example.net" })).toBe("https://va-0f8a6a1e-<port>.example.net");
    expect(publicUrlPattern({})).toBeNull();
  });
});
