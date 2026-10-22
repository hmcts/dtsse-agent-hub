// A tmux that keeps a set of live session names and records what it was asked to do, so the supervisor's
// decisions can be asserted without a tmux server.
import { randomUUID } from "node:crypto";
import type { StartSessionOptions, Tmux } from "../assistant/tmux.ts";

export type TmuxCall = ["start", StartSessionOptions] | ["send-keys", ...string[]] | ["kill", string];

export type FakeTmux = Tmux & {
  alive: Set<string>;
  calls: TmuxCall[];
  starts: () => StartSessionOptions[];
  sent: (name: string) => TmuxCall[];
  killed: (name: string) => boolean;
};

export function fakeTmux(): FakeTmux {
  const alive = new Set<string>();
  const calls: TmuxCall[] = [];
  return {
    alive,
    calls,
    starts: () => calls.filter((c) => c[0] === "start").map((c) => c[1] as StartSessionOptions),
    sent: (name) => calls.filter((c) => c[0] === "send-keys" && c[1] === name),
    killed: (name) => calls.some((c) => c[0] === "kill" && c[1] === name),
    list: async () => [...alive],
    has: async (name) => alive.has(name),
    start: async (opts) => {
      calls.push(["start", opts]);
      alive.add(opts.name);
    },
    sendKeys: async (name, ...keys) => {
      calls.push(["send-keys", name, ...keys]);
    },
    kill: async (name) => {
      calls.push(["kill", name]);
      alive.delete(name);
    }
  };
}

let nextConversation = 0;

/** A conversation whose first 8 hex digits, and so whose tmux session name, no other call shares. */
export function conversation(): { conversation_id: string; session_id: string; resume: boolean } {
  const n = (++nextConversation).toString(16).padStart(8, "0");
  return { conversation_id: `${n}-0000-4000-8000-${"0".repeat(12)}`, session_id: randomUUID(), resume: false };
}
