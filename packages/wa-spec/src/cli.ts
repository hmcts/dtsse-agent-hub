import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { diffPaths, renderDifferences } from "./diff.ts";
import { exists, isDirectory, listDir, readText, writeText } from "./file-io.ts";
import { generateAll } from "./generator.ts";
import { importDmns, renderReport } from "./importer.ts";
import { layoutPathFor, parseLayout, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";
import { renderTaskRows, taskRows } from "./task-view.ts";

const USAGE = `wa-spec: Work Allocation configuration spec

  wa-spec import <dmn-dir> -o <spec.yaml> [--report <report.md>] [--jurisdiction J] [--service-code C] [--display-name N]
                                                 also writes the ids and layout to <spec>.layout.yaml
  wa-spec generate <spec.yaml> -o <dir>          uses <spec>.layout.yaml when it exists
  wa-spec diff <a> <b> [--ignore-rule-order]     two DMN files or two directories, or a file and a directory holding
                                                 a file of the same name; exits 1 when they differ
  wa-spec show <spec.yaml> <taskId>              the rows of every kind that concern one task
`;

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
      .filter((name) => name.startsWith("wa-task-") && name.endsWith(".dmn"))
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
    const files = generateAll(parseSpec(readText(specPath)), exists(layoutPath) ? parseLayout(readText(layoutPath)) : undefined);
    for (const file of files) {
      writeText(join(values.output, file.fileName), file.xml);
    }
    process.stdout.write(`generated ${files.length} files in ${values.output}\n`);
    return 0;
  }
  if (command === "diff") {
    const [a, b] = positionals;
    if (!a || !b) {
      fail(USAGE);
    }
    const side = (path: string, counterpart: string) => {
      if (!isDirectory(path)) {
        return { dir: dirname(path), file: basename(path) };
      }
      return isDirectory(counterpart) ? { dir: path } : { dir: path, file: basename(counterpart) };
    };
    for (const [file, other] of [
      [a, b],
      [b, a]
    ] as const) {
      if (!isDirectory(file) && isDirectory(other) && !exists(join(other, basename(file)))) {
        fail(`${other} has no file named ${basename(file)} to compare ${file} with`);
      }
    }
    const differences = diffPaths(side(a, b), side(b, a), { ignoreRuleOrder: values["ignore-rule-order"] });
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
    process.stdout.write(`${renderTaskRows(taskRows(parseSpec(readText(specPath)), taskId))}\n`);
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
