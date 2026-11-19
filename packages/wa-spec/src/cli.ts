import { join } from "node:path";
import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { diffPaths, renderDifferences } from "./diff.ts";
import { exists, listDir, readText, writeText } from "./file-io.ts";
import { parseFileName } from "./file-names.ts";
import { generateAll } from "./generator.ts";
import { importDmns, renderReport } from "./importer.ts";
import { layoutPathFor, parseLayout, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";
import { renderTaskRows, taskRows } from "./task-view.ts";

const USAGE = `wa-spec: Work Allocation configuration spec

  wa-spec import <dmn-dir> -o <spec.yaml> [--report <report.md>] [--jurisdiction J] [--service-code C] [--display-name N]
                                                 also writes the ids and layout to <spec>.layout.yaml
  wa-spec generate <spec.yaml> -o <dir>          uses <spec>.layout.yaml when it exists; lists the task DMNs of the
                                                 spec's service in <dir> that it did not generate, and leaves them
  wa-spec diff <a> <b> [--ignore-rule-order]     two DMN files or two directories, or a file and a directory holding
                                                 a file of the same name; exits 1 when they differ
  wa-spec show <spec.yaml> <taskId>              the rows of every kind that concern one task
`;

/** Reads and parses a file the tools wrote, naming the file and, for a schema failure, each field at fault. */
function load<T>(path: string, parse: (text: string) => T): T {
  try {
    return parse(readText(path));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`${path} is not valid:\n${error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n")}`);
    }
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      output: { type: "string", short: "o" },
      report: { type: "string" },
      jurisdiction: { type: "string" },
      "service-code": { type: "string" },
      "display-name": { type: "string" },
      "ignore-rule-order": { type: "boolean" }
    }
  });
  if (command === "import") {
    const [dir] = positionals;
    if (!dir || !values.output) {
      fail(USAGE);
    }
    const files = listDir(dir)
      .filter((name) => name.endsWith(".dmn"))
      .map((name) => ({ name, xml: readText(join(dir, name)) }));
    const { spec, layout, report } = importDmns(files, {
      jurisdiction: values.jurisdiction,
      serviceCode: values["service-code"],
      displayName: values["display-name"]
    });
    writeText(values.output, stringifySpec(spec));
    writeText(layoutPathFor(values.output), stringifyLayout(layout));
    const markdown = renderReport(report);
    if (values.report) {
      writeText(values.report, markdown);
    }
    const rawFeel = Object.values(report.entries).reduce((n, e) => n + e.rawFeel, 0);
    process.stdout.write(`imported ${report.files.length} files; ${rawFeel} raw FEEL entries; ${report.unrepresentable.length} unrepresentable constructs\n`);
    return report.unrepresentable.length > 0 ? 1 : 0;
  }
  if (command === "generate") {
    const [specPath] = positionals;
    if (!specPath || !values.output) {
      fail(USAGE);
    }
    const layoutPath = layoutPathFor(specPath);
    const spec = load(specPath, parseSpec);
    const files = generateAll(spec, exists(layoutPath) ? load(layoutPath, parseLayout) : undefined);
    for (const file of files) {
      writeText(join(values.output, file.fileName), file.xml);
    }
    const made = new Set(files.map((file) => `${file.kind}/${file.caseType}`));
    const stale = (exists(values.output) ? listDir(values.output) : []).filter((name) => {
      const parsed = parseFileName(name);
      return parsed?.service === spec.service.slug && !made.has(`${parsed.kind}/${parsed.caseType}`);
    });
    if (stale.length > 0) {
      process.stderr.write(`left in place, as the spec does not generate them: ${stale.join(", ")}\n`);
    }
    process.stdout.write(`generated ${files.length} files in ${values.output}\n`);
    return 0;
  }
  if (command === "diff") {
    const [a, b] = positionals;
    if (!a || !b) {
      fail(USAGE);
    }
    const differences = diffPaths(a, b, { ignoreRuleOrder: values["ignore-rule-order"] });
    if (differences.length === 0) {
      process.stdout.write("no differences\n");
      return 0;
    }
    process.stdout.write(`${renderDifferences(differences)}\n${differences.length} differences\n`);
    return 1;
  }
  if (command === "show") {
    const [specPath, taskId] = positionals;
    if (!specPath || !taskId) {
      fail(USAGE);
    }
    process.stdout.write(`${renderTaskRows(taskRows(load(specPath, parseSpec), taskId))}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return command === undefined || command === "help" ? 0 : 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
