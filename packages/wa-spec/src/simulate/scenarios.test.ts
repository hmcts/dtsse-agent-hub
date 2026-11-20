import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFileName } from "../file-names.ts";
import { generateDocument } from "../generator.ts";
import { importDmns } from "../importer.ts";
import type { Spec } from "../schema.ts";
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

/** The workspace's `apps/` directory, found above this package; it is absent when the package is checked out alone. */
function appsDir(): string | undefined {
  for (let dir = here("."); dirname(dir) !== dir; dir = dirname(dir)) {
    if (existsSync(join(dir, "apps", "et"))) {
      return join(dir, "apps");
    }
  }
  return undefined;
}

/**
 * Each service's scenarios were dumped from its own Java DMN tests by `scripts/dump-scenarios.mjs`. ET runs against the spec
 * committed in `examples/`. The others run against the spec their DMNs import to, read from the service's clone in the workspace,
 * so no copy of those DMNs is kept here; they are skipped where the clone is absent. `prl` has no committed scenarios.
 */
const importedFrom = (clone: string) => {
  const resources = join(appsDir() ?? "", clone, "src/main/resources");
  return {
    available: appsDir() !== undefined && existsSync(resources),
    spec: (): Spec =>
      importDmns(
        readdirSync(resources)
          .filter((name) => /^wa-task-.*\.dmn$/.test(name))
          .map((name) => ({ name, xml: readFileSync(join(resources, name), "utf8") }))
      ).spec
  };
};

const SERVICES = [
  { name: "et", available: true, spec: (): Spec => parseSpec(readFileSync(here("../../examples/et/spec.yaml"), "utf8")) },
  { name: "sscs", ...importedFrom("sscs/sscs-task-configuration") },
  { name: "civil", ...importedFrom("civil/civil-wa-task-configuration") },
  { name: "prl", ...importedFrom("prl/prl-wa-task-configuration") }
]
  .map((service) => ({ ...service, scenarios: `../../test-fixtures/${service.name}-scenarios` }))
  .filter((service) => service.available && existsSync(here(service.scenarios)));

describe.each(SERVICES)("$name's Java DMN scenarios", ({ spec: loadSpec, scenarios: dir }) => {
  const spec = loadSpec();
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
