import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("package conventions", () => {
  it("should leave no bare .sort() anywhere when the package source is scanned", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (/\.ts$/.test(name) && !name.endsWith("conventions.test.ts") && /\.sort\(\)/.test(readFileSync(path, "utf8"))) {
          hits.push(path);
        }
      }
    };
    walk(join(import.meta.dirname));
    expect(hits).toEqual([]);
  });
});
