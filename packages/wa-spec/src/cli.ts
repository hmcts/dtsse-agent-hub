import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ENVIRONMENT_EXCLUDES, variablesFrom } from "./ccd/definition-files.ts";
import { lifecycleReport } from "./ccd/lifecycle-command.ts";
import { diffPaths, renderDifferences } from "./diff.ts";
import { exists, listDir, readText, writeText } from "./file-io.ts";
import { decisionKeyOf, parseFileName } from "./file-names.ts";
import { generateAll } from "./generator.ts";
import { importDmns, renderReport } from "./importer.ts";
import { explained, layoutPathOf, loadSpecFile, loadSpecOnly, orderPathBeside, stringifyModel, stringifyOrdering } from "./model-io.ts";
import { liftSpec, renderLiftReport } from "./model-lift.ts";
import { compareSpecs } from "./spec-diff.ts";
import { layoutPathFor, parseSpec, stringifyLayout, stringifySpec } from "./spec-io.ts";
import { listTaskFiles } from "./task-files.ts";
import { renderTaskRows, taskRows } from "./task-view.ts";

const USAGE = `wa-spec: Work Allocation configuration spec

  wa-spec import <dmn-dir> -o <spec.yaml> [--report <report.md>] [--jurisdiction J] [--service-code C] [--display-name N]
                                                 also writes the ids and layout to <spec>.layout.yaml
  wa-spec generate <spec.yaml|model.yaml> -o <dir> [--layout <layout.yaml>]
                                                 a model ("kind: wa-model") is compiled first; the layout is --layout,
                                                 the model layout field, or <name>.layout.yaml. Lists the task DMNs of
                                                 the spec's service in <dir> that it did not generate, and leaves them
  wa-spec lift <spec.yaml> -o <model.yaml> [--report <report.md>] [--layout <layout.yaml>]
                                                 the task- and role-centric model of a spec, with <model>.order.yaml
                                                 that keeps the tables' row order; exits 1 unless it compiles back equal
  wa-spec compile <model.yaml> -o <spec.yaml> [--layout <layout.yaml>]
                                                 the table-centric spec of a model, with its layout copied beside it
  wa-spec diff <a> <b> [--ignore-rule-order]     two DMN files or two directories, or a file and a directory holding
                                                 a file of the same name; exits 1 when they differ. Two YAML files
                                                 (specs or models) are compared as specs
  wa-spec show <spec.yaml|model.yaml> <taskId>   the rows of every kind that concern one task
  wa-spec lifecycle <definition-dir> --spec <spec.yaml|model.yaml> [--case-type X] [--env prod|nonprod | --exclude <glob,...>]
                       [--var NAME=value]... [--format yaml|json]
                                                 the spec's tasks laid over the case lifecycle of a CCD definition, with warnings for
                                                 what the definition cannot back. <definition-dir> is the directory the service gives
                                                 ccd-definition-processor as -D. Nothing is excluded unless --exclude (the processor's -e,
                                                 repeatable or comma separated, matched per path segment) or --env (ET's pair of
                                                 patterns) says so. \${NAME} placeholders are replaced from CCD_DEF* environment variables
                                                 and --var, as the processor does; one a column the reader needs still has is an error
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
      "ignore-rule-order": { type: "boolean" },
      spec: { type: "string" },
      "case-type": { type: "string" },
      env: { type: "string" },
      exclude: { type: "string", multiple: true },
      var: { type: "string", multiple: true },
      format: { type: "string" }
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
    const { spec, layout } = loadSpecFile(specPath, values.layout);
    const files = generateAll(spec, layout);
    for (const file of files) {
      writeText(join(values.output, file.fileName), file.xml);
    }
    const made = new Set(files.map((file) => file.fileName));
    const madeKeys = new Set(files.map((file) => decisionKeyOf(spec.service.slug, file.kind, file.caseType)));
    const stale = (exists(values.output) ? listTaskFiles(values.output, made) : []).filter((file) => {
      const parsed = file.key === undefined ? undefined : parseFileName(`${file.key}.dmn`);
      return file.key !== undefined && (madeKeys.has(file.key) || parsed?.service === spec.service.slug);
    });
    if (stale.length > 0) {
      process.stderr.write(`left in place, as the spec does not generate them: ${stale.map((file) => file.name).join(", ")}\n`);
    }
    process.stdout.write(`generated ${files.length} files in ${values.output}\n`);
    return 0;
  }
  if (command === "lift") {
    const [specPath] = positionals;
    if (!specPath || !values.output) {
      fail(USAGE);
    }
    const spec = explained(specPath, () => parseSpec(readText(specPath)));
    const layoutPath = layoutPathOf(specPath, values.layout, process.cwd());
    const orderPath = orderPathBeside(values.output);
    const { model, ordering, report } = liftSpec(spec, {
      ...(layoutPath ? { layout: relative(dirname(resolve(values.output)), layoutPath) } : {}),
      order: basename(orderPath)
    });
    writeText(values.output, stringifyModel(model));
    writeText(orderPath, stringifyOrdering(ordering));
    if (values.report) {
      writeText(values.report, renderLiftReport(report, spec.service.displayName ?? spec.service.slug));
    }
    const residue = Object.values(report.counts).reduce((n, c) => n + c.residue, 0);
    const rows = Object.values(report.counts).reduce((n, c) => n + c.rows, 0);
    process.stdout.write(
      `lifted ${rows - residue} of ${rows} rows into ${report.tasks} tasks and ${report.profiles} profiles; ${residue} rows stay in tables; ${report.differences.length === 0 ? "compiles back equal" : `${report.totalDifferences} differences on compiling back`}\n`
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
    writeText(values.output, stringifySpec(loaded.spec));
    if (loaded.layout) {
      const target = layoutPathFor(values.output);
      if (loaded.layoutPath !== resolve(target)) {
        writeText(target, stringifyLayout(loaded.layout));
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
      const { differences, total } = compareSpecs(loadSpecOnly(a), loadSpecOnly(b), { ignoreRuleOrder: values["ignore-rule-order"] });
      const shown = differences.length < total ? `first ${differences.length} of ${total} differences` : `${total} differences`;
      process.stdout.write(total === 0 ? "no differences\n" : `${differences.join("\n")}\n${shown}\n`);
      return total === 0 ? 0 : 1;
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
    process.stdout.write(`${renderTaskRows(taskRows(loadSpecOnly(specPath), taskId))}\n`);
    return 0;
  }
  if (command === "lifecycle") {
    const [definitionDir] = positionals;
    if (!definitionDir || !values.spec) {
      fail(USAGE);
    }
    if (
      (values.env !== undefined && values.env !== "prod" && values.env !== "nonprod") ||
      (values.format !== undefined && values.format !== "yaml" && values.format !== "json")
    ) {
      fail(`--env is prod or nonprod and --format is yaml or json\n${USAGE}`);
    }
    if (values.env !== undefined && values.exclude !== undefined) {
      fail("--env and --exclude are alternatives");
    }
    const exclude =
      values.exclude?.flatMap((patterns) => patterns.split(",").filter(Boolean)) ?? (values.env ? ENVIRONMENT_EXCLUDES[values.env as "prod" | "nonprod"] : []);
    const given = (values.var ?? []).map((entry) => entry.split(/=(.*)/s));
    if (given.some(([name, value]) => !name || value === undefined)) {
      fail("--var is NAME=value");
    }
    const variables = { ...variablesFrom(process.env), ...Object.fromEntries(given.map(([name, value]) => [name, value])) } as Record<string, string>;
    process.stdout.write(
      lifecycleReport({
        definitionDir,
        specPath: values.spec,
        caseType: values["case-type"],
        exclude,
        variables,
        format: values.format === "json" ? "json" : "yaml"
      })
    );
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
