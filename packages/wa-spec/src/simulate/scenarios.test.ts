import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFileName } from "../file-names.ts";
import { generateDocument } from "../generator.ts";
import { parseSpec } from "../spec-io.ts";
import { evaluateDecision } from "./dmn-eval.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * A date and time within half an hour of when the Java tests ran is `now()` or `today()` at that moment, which the run cannot
 * repeat to the second, so it is compared as that instant; the zone and region are written differently by feelin and Java.
 */
function maskNow(value: unknown, dumpedAt: string): unknown {
  const instant = Date.parse(dumpedAt);
  return JSON.parse(
    JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?(\.\d+)?(Z|[+-]\d\d:\d\d)?(\[[^\]]+\])?/g, (text) => {
      const zoned = /(Z|[+-]\d\d:\d\d)(\[.*\])?$/.test(text);
      const parsed = Date.parse(zoned ? text.replace(/\[.*$/, "") : `${text}Z`);
      return Math.abs(parsed - instant) < 30 * 60_000 ? "<now>" : text;
    })
  );
}

interface Fixture {
  decision: string;
  /** When the Java tests ran: a DMN that reads today() or now() answers for that day. */
  dumpedAt: string;
  scenarios: Array<{ required?: string; requiredName?: string; input: Record<string, unknown>; output: Array<Record<string, unknown>> }>;
}

/**
 * Each service's scenarios were dumped from its own Java DMN tests by `scripts/dump-scenarios.mjs`, which writes the spec the
 * service's DMNs import to beside them as `spec.yaml`. ET's is the one committed in `examples/`. Directories that are not
 * committed, such as `prl-scenarios`, are run when present.
 */
const SERVICES = readdirSync(here("../../test-fixtures"))
  .filter((entry) => entry.endsWith("-scenarios"))
  .map((entry) => {
    const own = here(`../../test-fixtures/${entry}/spec.yaml`);
    return {
      name: entry.replace(/-scenarios$/, ""),
      scenarios: `../../test-fixtures/${entry}`,
      specPath: existsSync(own) ? own : here("../../examples/et/spec.yaml")
    };
  });

describe.each(SERVICES)("$name's Java DMN scenarios", ({ specPath, scenarios: dir }) => {
  const spec = parseSpec(readFileSync(specPath, "utf8"));
  for (const file of readdirSync(here(dir)).filter((name) => name.endsWith(".json"))) {
    const fixture = JSON.parse(readFileSync(join(here(dir), file), "utf8")) as Fixture;
    const parsed = parseFileName(`${fixture.decision}.dmn`);
    const document = parsed && generateDocument(spec, parsed.kind, parsed.caseType);
    describe(fixture.decision, () => {
      it.each(fixture.scenarios.map((scenario, index) => ({ ...scenario, index })))(
        "should give Camunda's output when scenario $index runs",
        ({ required, requiredName, input, output }) => {
          const target = required === undefined ? document?.decisions[0] : document?.decisions.find((d) => d.name === requiredName);
          expect(document && target).toBeDefined();
          if (document && target) {
            expect(maskNow(evaluateDecision(document, target.id, input, fixture.dumpedAt), fixture.dumpedAt)).toEqual(maskNow(output, fixture.dumpedAt));
          }
        }
      );
    });
  }
});
