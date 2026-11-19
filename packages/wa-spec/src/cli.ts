import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { diffPaths, renderDifferences } from "./diff.ts";
import { generateAll } from "./generator.ts";
import { importDmns, renderReport } from "./importer.ts";
import { loadSpecFile, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec, renderLiftReport } from "./model-lift.ts";
import { diffSpecs } from "./spec-diff.ts";
import { layoutPathFor, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";
import { renderTaskRows, taskRows } from "./task-view.ts";

const USAGE = `wa-spec: Work Allocation configuration spec

  wa-spec import <dmn-dir> -o <spec.yaml> [--report <report.md>] [--jurisdiction J] [--service-code C] [--display-name N]
                                                 also writes the ids and layout to <spec>.layout.yaml
  wa-spec generate <spec.yaml|model.yaml> -o <dir> [--layout <layout.yaml>]
                                                 a model ("kind: wa-model") is compiled first; the layout is
                                                 --layout, the model layout field, or <name>.layout.yaml
  wa-spec lift <spec.yaml> -o <model.yaml> [--report <report.md>]
                                                 the task- and role-centric model of a spec, with <model>.order.yaml
                                                 that keeps the tables' row order; exits 1 unless it compiles back equal
  wa-spec compile <model.yaml> -o <spec.yaml>    the table-centric spec of a model, with its layout copied beside it
  wa-spec diff <a> <b> [--ignore-rule-order]     two DMN files or two directories, or a file and a directory holding
                                                 a file of the same name; exits 1 when they differ. Two YAML files
                                                 (specs or models) are compared as specs
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
      layout: { type: "string" },
      "ignore-rule-order": { type: "boolean" }
    }
  });
  if (command === "import") {
    const [dir] = positionals;
    if (!dir || !values.output) {
      fail(USAGE);
    }
    const files = readdirSync(dir)
      .filter((name) => name.startsWith("wa-task-") && name.endsWith(".dmn"))
      .map((name) => ({ name, xml: readFileSync(join(dir, name), "utf8") }));
    const { spec, layout, report } = importDmns(files, {
      jurisdiction: values.jurisdiction,
      serviceCode: values["service-code"],
      displayName: values["display-name"]
    });
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, stringifySpec(spec));
    writeFileSync(layoutPathFor(values.output), stringifyLayout(layout));
    const markdown = renderReport(report);
    if (values.report) {
      mkdirSync(dirname(values.report), { recursive: true });
      writeFileSync(values.report, markdown);
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
    mkdirSync(values.output, { recursive: true });
    const loaded = loadSpecFile(specPath, values.layout);
    const files = generateAll(loaded.spec, loaded.layout);
    for (const file of files) {
      writeFileSync(join(values.output, file.fileName), file.xml);
    }
    process.stdout.write(`generated ${files.length} files in ${values.output}\n`);
    return 0;
  }
  if (command === "lift") {
    const [specPath] = positionals;
    if (!specPath || !values.output) {
      fail(USAGE);
    }
    const spec = parseSpec(readFileSync(specPath, "utf8"));
    const layoutPath = layoutPathFor(specPath);
    const orderPath = `${values.output.replace(/\.ya?ml$/, "")}.order.yaml`;
    const { model, ordering, report } = liftSpec(spec, {
      ...(existsSync(layoutPath) ? { layout: relative(dirname(resolve(values.output)), resolve(layoutPath)) } : {}),
      order: basename(orderPath)
    });
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, stringifyModel(model));
    writeFileSync(orderPath, stringifyOrdering(ordering));
    if (values.report) {
      mkdirSync(dirname(values.report), { recursive: true });
      writeFileSync(values.report, renderLiftReport(report, spec.service.displayName ?? spec.service.slug));
    }
    const residue = Object.values(report.counts).reduce((n, c) => n + c.residue, 0);
    const rows = Object.values(report.counts).reduce((n, c) => n + c.rows, 0);
    process.stdout.write(
      `lifted ${rows - residue} of ${rows} rows into ${report.tasks} tasks and ${report.profiles} profiles; ${residue} rows stay in tables; ${report.differences.length === 0 ? "compiles back equal" : `${report.differences.length} differences on compiling back`}\n`
    );
    return report.differences.length === 0 ? 0 : 1;
  }
  if (command === "compile") {
    const [modelPath] = positionals;
    if (!modelPath || !values.output) {
      fail(USAGE);
    }
    const loaded = loadSpecFile(modelPath, values.layout);
    if (!loaded.isModel) {
      fail(`${modelPath} is not a model (it has no \`kind: wa-model\`)`);
    }
    mkdirSync(dirname(values.output), { recursive: true });
    writeFileSync(values.output, stringifySpec(loaded.spec));
    if (loaded.layout) {
      const target = layoutPathFor(values.output);
      if (loaded.layoutPath !== resolve(target)) {
        writeFileSync(target, stringifyLayout(loaded.layout));
      }
    }
    process.stdout.write(`compiled ${modelPath} to ${values.output}\n`);
    return 0;
  }
  if (command === "diff") {
    const [a, b] = positionals;
    if (!a || !b) {
      fail(USAGE);
    }
    if (/\.ya?ml$/.test(a) && /\.ya?ml$/.test(b)) {
      const differences = diffSpecs(loadSpecFile(a).spec, loadSpecFile(b).spec);
      process.stdout.write(differences.length === 0 ? "no differences\n" : `${differences.join("\n")}\n${differences.length} differences\n`);
      return differences.length === 0 ? 0 : 1;
    }
    const isDir = (path: string) => statSync(path).isDirectory();
    const side = (path: string, counterpart: string) => {
      if (!isDir(path)) {
        return { dir: dirname(path), file: basename(path) };
      }
      return isDir(counterpart) ? { dir: path } : { dir: path, file: basename(counterpart) };
    };
    for (const [file, other] of [
      [a, b],
      [b, a]
    ] as const) {
      if (!isDir(file) && isDir(other) && !existsSync(join(other, basename(file)))) {
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
    process.stdout.write(`${renderTaskRows(taskRows(parseSpec(readFileSync(specPath, "utf8")), taskId))}\n`);
    return 0;
  }
  process.stdout.write(USAGE);
  return command === undefined || command === "help" ? 0 : 2;
}

process.exitCode = main(process.argv.slice(2));
