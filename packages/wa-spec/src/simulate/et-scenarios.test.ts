import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFileName } from "../file-names.ts";
import { generateDocument } from "../generator.ts";
import { parseSpec } from "../spec-io.ts";
import { evaluateDecision } from "./dmn-eval.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const spec = parseSpec(readFileSync(here("../../examples/et/spec.yaml"), "utf8"));
const dir = here("../../test-fixtures/et-scenarios");

interface Fixture {
  decision: string;
  scenarios: Array<{ test: string; input: Record<string, unknown>; output: Array<Record<string, unknown>> }>;
}

/**
 * The dump holds the instant Camunda's `now()` gave when the Java tests ran, so a timestamp is compared by shape: feelin gives
 * `Z` where Java's ZonedDateTime adds the zone id.
 */
const maskNow = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z(\[[^\]]+\])?/g, "<now>"));

describe("ET's Java DMN scenarios", () => {
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const fixture = JSON.parse(readFileSync(join(dir, file), "utf8")) as Fixture;
    const parsed = parseFileName(`${fixture.decision}.dmn`);
    const document = parsed && generateDocument(spec, parsed.kind, parsed.caseType);
    describe(fixture.decision, () => {
      it.each(fixture.scenarios.map((scenario, index) => ({ ...scenario, index })))(
        "should give Camunda's output when scenario $index of $test runs",
        ({ input, output }) => {
          expect(document).toBeDefined();
          if (document) {
            expect(maskNow(evaluateDecision(document, document.decisions[0]?.id ?? "", input))).toEqual(maskNow(output));
          }
        }
      );
    });
  }
});
