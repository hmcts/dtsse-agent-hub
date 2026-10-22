// The web servers a virtual agent's pod is running, found in /proc/net/tcp and /proc/net/tcp6 and
// reported to agent-hub, which routes https://va-<8 hex>-<port>.<domain> to each one it can reach.
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./env.ts";

export const PORTS_POLL_MS = 5000;
export const APPEAR_READS = 2;
export const DISAPPEAR_READS = 3;
export const MIN_PORT = 1024;
export const MAX_REPORTED = 10;
export const DEFAULT_PUBLIC_DOMAIN = "preview.platform.hmcts.net";
const LISTEN = "0A";

export type ProcNetSocket = {
  address: string;
  port: number;
  state: string;
};

export type AddressKind = "loopback" | "reachable";

export type Listening = {
  open: number[];
  local: number[];
};

// The body of `PUT /api/virtual/{id}/ports`. It lives here rather than in `api.ts` because this is the
// feature that decides what goes in it.
export type PortsReport = {
  ports: number[];
  local_only: number[];
};

// Only the one call the watcher makes, so a test can stand in for the whole client.
export type PortsReporter = {
  putPorts: (id: string, body: PortsReport) => Promise<unknown>;
};

export type PortTick = "settling" | "unchanged" | "reported" | "error";

const byNumber = (a: number, b: number): number => a - b;

/** Every socket in a /proc/net/tcp or tcp6 table: its hex local address, port and hex state. */
export function parseProcNet(text: string): ProcNetSocket[] {
  const sockets: ProcNetSocket[] = [];
  for (const line of String(text).split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const m = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(fields[1] || "");
    if (!m || !fields[3]) {
      continue;
    }
    sockets.push({ address: (m[1] as string).toUpperCase(), port: Number.parseInt(m[2] as string, 16), state: fields[3].toUpperCase() });
  }
  return sockets;
}

// The kernel prints each 32-bit word of an address in host byte order, so 127.0.0.1 is 0100007F
// and ::1 is 00000000000000000000000001000000.
function ipv4Loopback(word: string): boolean {
  return word.length === 8 && word.slice(6) === "7F";
}

/** `loopback` for 127.0.0.0/8, ::1 and ::ffff:127.x; otherwise `reachable`, which a Service can connect to. */
export function addressKind(hex: string): AddressKind {
  if (hex.length === 8) {
    return ipv4Loopback(hex) ? "loopback" : "reachable";
  }
  if (hex === "00000000000000000000000001000000") {
    return "loopback";
  }
  if (hex.slice(0, 16) === "0".repeat(16) && hex.slice(16, 24) === "FFFF0000" && ipv4Loopback(hex.slice(24))) {
    return "loopback";
  }
  return "reachable";
}

/** Ports listening from MIN_PORT up, split into those a Service can reach and those on loopback alone. */
export function listeners(tables: string[], ignore: Set<number> = new Set()): Listening {
  const open = new Set<number>();
  const local = new Set<number>();
  for (const text of tables) {
    for (const s of parseProcNet(text)) {
      if (s.state !== LISTEN || s.port < MIN_PORT || ignore.has(s.port)) {
        continue;
      }
      (addressKind(s.address) === "loopback" ? local : open).add(s.port);
    }
  }
  return { open: [...open].sort(byNumber), local: [...local].filter((p) => !open.has(p)).sort(byNumber) };
}

export type DebounceOptions = {
  appear?: number;
  disappear?: number;
};

/**
 * A port joins the set once seen on `appear` reads in a row and leaves it once missing from
 * `disappear` in a row, so a server that is restarting keeps its URL.
 */
export function createDebounce({ appear = APPEAR_READS, disappear = DISAPPEAR_READS }: DebounceOptions = {}): (current: Iterable<number>) => number[] {
  const ports = new Map<number, { seen: number; missing: number; shown: boolean }>();
  return (current) => {
    const now = new Set(current);
    for (const port of now) {
      if (!ports.has(port)) {
        ports.set(port, { seen: 0, missing: 0, shown: false });
      }
    }
    for (const [port, p] of ports) {
      if (now.has(port)) {
        p.seen += 1;
        p.missing = 0;
        if (p.seen >= appear) {
          p.shown = true;
        }
      } else {
        p.seen = 0;
        p.missing += 1;
        if (!p.shown || p.missing >= disappear) {
          ports.delete(port);
        }
      }
    }
    return [...ports]
      .filter(([, p]) => p.shown)
      .map(([port]) => port)
      .sort(byNumber);
  };
}

/** VIRTUAL_AGENT_IGNORE_PORTS: ports never reported, separated by commas or spaces. */
export function ignoredPorts(env: Env = process.env): Set<number> {
  return new Set(
    String(env.VIRTUAL_AGENT_IGNORE_PORTS || "")
      .split(/[\s,]+/)
      .filter((p) => /^\d+$/.test(p))
      .map(Number)
  );
}

export function procNetDir(env: Env = process.env): string {
  return env.AGENT_HUB_PROC_NET || "/proc/net";
}

/** A table that cannot be read, as tcp6 on a kernel without IPv6, counts as empty. */
export function readTables(dir: string = procNetDir()): string[] {
  return ["tcp", "tcp6"].map((name) => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return "";
    }
  });
}

export type PortWatcherOptions = {
  api: PortsReporter;
  id: string;
  read?: () => string[];
  ignore?: Set<number>;
  appear?: number;
  disappear?: number;
  say?: (message: string) => void;
};

/**
 * One read per tick. Nothing is reported until the debounce has had DISAPPEAR_READS reads to
 * settle, and after that only a change; a failed report is tried again on the next tick.
 */
export function createPortWatcher({
  api,
  id,
  read = () => readTables(),
  ignore = new Set(),
  appear = APPEAR_READS,
  disappear = DISAPPEAR_READS,
  say = () => {}
}: PortWatcherOptions): () => Promise<PortTick> {
  const open = createDebounce({ appear, disappear });
  const local = createDebounce({ appear, disappear });
  let reads = 0;
  let reported: string | null = null;
  let capped = false;
  return async function tick() {
    const found = listeners(read(), ignore);
    const ports = open(found.open);
    const localOnly = local(found.local).filter((p) => !ports.includes(p));
    reads += 1;
    if (reads < disappear) {
      return "settling";
    }
    const body: PortsReport = { ports: ports.slice(0, MAX_REPORTED), local_only: localOnly.slice(0, MAX_REPORTED) };
    const over = ports.length > MAX_REPORTED || localOnly.length > MAX_REPORTED;
    if (over && !capped) {
      say(`ports: more than ${MAX_REPORTED} listening; reporting the lowest ${MAX_REPORTED}`);
    }
    capped = over;
    const key = JSON.stringify(body);
    if (key === reported) {
      return "unchanged";
    }
    try {
      await api.putPorts(id, body);
    } catch (e) {
      say(`ports: reporting ${key} failed: ${(e as Error).message}`);
      return "error";
    }
    reported = key;
    say(`ports: reported ${body.ports.join(", ") || "none"}${body.local_only.length ? `; on 127.0.0.1 only: ${body.local_only.join(", ")}` : ""}`);
    return "reported";
  };
}

export type WatchPortsOptions = {
  api: PortsReporter;
  id: string;
  env?: Env;
  intervalMs?: number;
  say?: (message: string) => void;
};

/** Runs the watcher every `intervalMs` until SIGTERM or SIGINT. */
export async function watchPorts({
  api,
  id,
  env = process.env,
  intervalMs = Number(env.AGENT_HUB_PORTS_MS) || PORTS_POLL_MS,
  say
}: WatchPortsOptions): Promise<void> {
  const tick = createPortWatcher({ api, id, read: () => readTables(procNetDir(env)), ignore: ignoredPorts(env), say });
  let wake: (() => void) | null = null;
  let stopping = false;
  const onSignal = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    while (!stopping) {
      await tick();
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, intervalMs);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** The pod's StatefulSet is `va-<first 8 characters of its id>`, as the hub names it. */
export function publicUrlPattern(env: Env = process.env): string | null {
  const id = env.AGENT_HUB_VIRTUAL_AGENT_ID;
  if (!id) {
    return null;
  }
  const domain = (env.VIRTUAL_AGENT_PUBLIC_DOMAIN || "").trim() || DEFAULT_PUBLIC_DOMAIN;
  return `https://va-${id.slice(0, 8)}-<port>.${domain}`;
}
