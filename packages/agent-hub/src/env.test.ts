import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENV_KEYS } from "./env.ts";

const BIN = fileURLToPath(new URL("../bin/agent-hub", import.meta.url));

// Names bash itself provides, or locals the script sets, rather than environment this client reads.
const BASH_OWN = new Set(["BASH_SOURCE", "BASH_REMATCH", "HERE", "CLI"]);

describe("ENV_KEYS", () => {
  it("should hold every name exactly once when read as a set", () => {
    expect(new Set(ENV_KEYS).size).toBe(ENV_KEYS.length);
  });

  it("should be sorted by code point so an addition lands in one place", () => {
    expect([...ENV_KEYS]).toEqual([...ENV_KEYS].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it("should name only upper-case environment variables", () => {
    for (const key of ENV_KEYS) {
      expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it("should not carry AGENT_HUB_VIRTUAL, which the launch-token predicate replaced", () => {
    expect(ENV_KEYS).not.toContain("AGENT_HUB_VIRTUAL");
  });

  it("should cover every variable the bash gate reads", () => {
    const script = fs.readFileSync(BIN, "utf8");
    const read = new Set<string>();
    for (const [, name] of script.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) {
      if (name && !BASH_OWN.has(name)) {
        read.add(name);
      }
    }
    expect(read.size).toBeGreaterThan(0);
    expect([...read].filter((name) => !(ENV_KEYS as readonly string[]).includes(name))).toEqual([]);
  });
});
