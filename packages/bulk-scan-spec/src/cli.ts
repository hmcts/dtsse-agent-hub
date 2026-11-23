import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { loadCcdDefinition } from "./ccd-propose.ts";
import { readWorkbook, selectSheet } from "./cells.ts";
import type { Pattern } from "./code-keys.ts";
import { loadCodeKeys, PATTERNS } from "./code-keys.ts";
import type { Target } from "./codegen/index.ts";
import { generateTarget, newCcdFieldFiles, TARGETS } from "./codegen/index.ts";
import { unsatisfiedRules, unsatisfiedSamples } from "./codegen/scenarios.ts";
import { classifyDrift, formatDrift, sheetInternalKeys, specKeys } from "./drift.ts";
import { requireOneForm, selectForms } from "./form-select.ts";
import { fromPdf } from "./from-pdf.ts";
import { roundTrip } from "./round-trip-run.ts";
import type { Bundle, FormSpec } from "./schema.ts";
import { bundleSchema, TRANSFORM_COLUMNS } from "./schema.ts";
import { generateSipWorkbook } from "./sip-generate.ts";
import { importSip } from "./sip-import.ts";
import { generateTransformWorkbook } from "./transform-generate.ts";
import { importTransformSheet } from "./transform-import.ts";

const USAGE = `usage:
  import   --transform <xlsx> [--sheet <name>] --out <spec.json>
  import   --sip <xlsx> --out <spec.json>
  from-pdf --pdf <form.pdf> [--house-style <spec.json> | --house-style <code file or dir> --pattern <p>] [--ccd <definition dir or CaseField.json> [--case-type <CaseTypeID>]] --out <draft.json>
  generate --spec <spec.json> [--sip <out.xlsx> [--template <sip.xlsx>]] [--transform <out.xlsx>] [--form <n>]
  drift    (--spec <spec.json> | --transform <xlsx> [--sheet <name>]) --pattern ${PATTERNS.join("|")} --code <file|dir> [--form <n>]
  codegen  --spec <spec.json> --target ${TARGETS.join("|")}|all --out <dir> [--package <java base package>] [--prefix <class prefix>] [--jurisdiction <J>] [--form <n>]
  roundtrip --transform <xlsx> [--sheet <name>] [--template <sip.xlsx>] [--out <dir>]`;

const OPTION_NAMES = [
  "case-type",
  "ccd",
  "code",
  "form",
  "house-style",
  "jurisdiction",
  "out",
  "package",
  "pattern",
  "pdf",
  "prefix",
  "sheet",
  "sip",
  "spec",
  "target",
  "template",
  "transform"
];

function options(argv: string[]): Map<string, string> {
  try {
    const { values } = parseArgs({
      args: argv,
      options: Object.fromEntries(OPTION_NAMES.map((name) => [name, { type: "string" as const }])),
      strict: true,
      allowPositionals: false
    });
    return new Map(Object.entries(values).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : [])));
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
  }
}

function need(opts: Map<string, string>, name: string): string {
  const value = opts.get(name);
  if (!value) {
    throw new Error(`--${name} is required\n${USAGE}`);
  }
  return value;
}

function save(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function loadBundle(path: string): Bundle {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw === "object" && raw !== null && "needsReview" in raw) {
    throw new Error(`${path} is a draft with no fields read from the PDF; fill it in (see its needsReview prompt) and remove needsReview first`);
  }
  return bundleSchema.parse(raw);
}

async function runImport(opts: Map<string, string>): Promise<void> {
  const out = need(opts, "out");
  if (opts.has("transform")) {
    const workbook = await readWorkbook(need(opts, "transform"));
    const sheet = selectSheet(workbook, opts.get("sheet"));
    const result = importTransformSheet(sheet);
    save(out, `${JSON.stringify({ forms: [result.spec] }, null, 2)}\n`);
    console.log(`${result.spec.sections.length} sections, ${result.spec.sections.reduce((n, s) => n + s.fields.length, 0)} field rows -> ${out}`);
    console.log(
      `logic cells: ${result.logicRows}, fully structured: ${result.parsedRows}, rules with English fragments: ${result.partialRows}, not parsed: ${result.unparsed.length}`
    );
    for (const t of result.rejectedTokens) {
      console.log(`  rejected ${t.column} token on row ${t.row}: ${JSON.stringify(t.token)}`);
    }
    for (const u of result.unresolvedConditions) {
      console.log(`  unresolved condition on row ${u.row}: ${JSON.stringify(u.label)}`);
    }
    for (const u of result.unparsed) {
      console.log(`  row ${u.row} ${u.id || "-"} ${u.keys[0] ?? ""}: ${u.reason}`);
    }
    return;
  }
  const workbook = await readWorkbook(need(opts, "sip"));
  const bundle = importSip(workbook);
  save(out, `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`${bundle.forms.length} form tabs -> ${out}`);
}

function houseKeys(opts: Map<string, string>): string[] | undefined {
  const path = opts.get("house-style");
  if (!path) {
    return undefined;
  }
  const pattern = opts.get("pattern");
  if (pattern) {
    return loadCodeKeys(checkedPattern(pattern), path).map((k) => k.key);
  }
  return loadBundle(path).forms.flatMap((form) => specKeys(form).map((k) => k.key));
}

async function runFromPdf(opts: Map<string, string>): Promise<void> {
  const out = need(opts, "out");
  const ccd = opts.get("ccd");
  const keys = houseKeys(opts);
  const definition = ccd ? loadCcdDefinition(ccd, opts.get("case-type")) : undefined;
  const caseType = definition?.caseType ?? opts.get("case-type");
  const result = await fromPdf({
    pdf: need(opts, "pdf"),
    ...(keys ? { houseKeys: keys } : {}),
    ...(definition ? { ccdFields: definition.fields } : {}),
    ...(caseType ? { caseType } : {})
  });
  const { needsReview } = result;
  if (needsReview) {
    const prompt = `${out.replace(/\.json$/, "")}.prompt.md`;
    save(prompt, needsReview.promptText);
    save(out, `${JSON.stringify({ ...result.bundle, needsReview: { reason: needsReview.reason, prompt } }, null, 2)}\n`);
    console.log(`${needsReview.reason}: nothing could be read from it. Fill in ${out} from the page images and text in ${prompt}.`);
    return;
  }
  save(out, `${JSON.stringify(result.bundle, null, 2)}\n`);
  const fields = result.bundle.forms.flatMap((f) => f.sections.flatMap((s) => s.fields));
  console.log(`${fields.length} fields, ${fields.filter((f) => f.group).length} XoR groups -> ${out}`);
  console.log(`review checklist (${result.checklist.length} guesses, lowest confidence first); rules are not proposed:`);
  for (const line of result.checklist) {
    console.log(`  ${line}`);
  }
}

async function runGenerate(opts: Map<string, string>): Promise<void> {
  const bundle = loadBundle(need(opts, "spec"));
  const forms = selectForms(bundle, opts.get("form"));
  const selected = { ...bundle, forms };
  const sipOut = opts.get("sip");
  const transformOut = opts.get("transform");
  if (!sipOut && !transformOut) {
    throw new Error(`nothing to generate: pass --sip and/or --transform\n${USAGE}`);
  }
  // Everything that can fail is settled before the first file is written.
  const transformForm = transformOut ? requireOneForm(bundle, opts.get("form")) : undefined;
  const template = sipOut && opts.has("template") ? await readWorkbook(need(opts, "template")) : undefined;
  const sipBook = sipOut ? generateSipWorkbook(selected, template) : undefined;
  const transformBook = transformForm ? generateTransformWorkbook(transformForm) : undefined;
  if (sipOut && sipBook) {
    save(sipOut, new Uint8Array((await sipBook.xlsx.writeBuffer()) as ArrayBuffer));
    console.log(`SIP -> ${sipOut}`);
  }
  if (transformOut && transformBook) {
    save(transformOut, new Uint8Array((await transformBook.xlsx.writeBuffer()) as ArrayBuffer));
    console.log(`transformation sheet -> ${transformOut}`);
  }
}

function checkedPattern(value: string): Pattern {
  const pattern = PATTERNS.find((p) => p === value);
  if (!pattern) {
    throw new Error(`--pattern must be one of ${PATTERNS.join(", ")}`);
  }
  return pattern;
}

async function runDrift(opts: Map<string, string>): Promise<void> {
  const pattern = checkedPattern(need(opts, "pattern"));
  let spec: FormSpec | undefined;
  let label: string;
  if (opts.has("spec")) {
    const bundle = loadBundle(need(opts, "spec"));
    spec = requireOneForm(bundle, opts.get("form"));
    label = `spec ${need(opts, "spec")}`;
  } else {
    const workbook = await readWorkbook(need(opts, "transform"));
    const sheet = selectSheet(workbook, opts.get("sheet"));
    spec = importTransformSheet(sheet).spec;
    label = `sheet ${sheet.name}`;
  }
  const code = loadCodeKeys(pattern, need(opts, "code"));
  const report = classifyDrift(specKeys(spec), code, sheetInternalKeys(spec));
  console.log(formatDrift(report, { spec: label, code: `${pattern} ${need(opts, "code")}` }));
}

async function runCodegen(opts: Map<string, string>): Promise<void> {
  const bundle = loadBundle(need(opts, "spec"));
  const spec = requireOneForm(bundle, opts.get("form"));
  const wanted = need(opts, "target");
  const targets = wanted === "all" ? [...TARGETS] : [wanted as Target];
  for (const t of targets) {
    if (!TARGETS.includes(t)) {
      throw new Error(`--target must be one of ${TARGETS.join(", ")} or all`);
    }
  }
  const out = need(opts, "out");
  const java = { basePackage: opts.get("package") ?? "com.example.bulkscan", classPrefix: opts.get("prefix") };
  for (const target of targets) {
    const files = generateTarget(target, spec, java, opts.get("jurisdiction"));
    for (const f of files) {
      save(join(out, f.path), f.content);
    }
    console.log(`${target}: ${files.length} files`);
  }
  const shared = newCcdFieldFiles(spec);
  for (const f of shared) {
    save(join(out, f.path), f.content);
  }
  if (shared.length > 0) {
    console.log(`new case fields: ${shared.map((f) => f.path).join(", ")}`);
  }
  const noSample = unsatisfiedSamples(spec);
  if (noSample.length > 0) {
    console.log(`no sample satisfies the format and maximum length of: ${noSample.join(", ")}`);
  }
  const stillWarns = unsatisfiedRules(spec);
  if (stillWarns.length > 0) {
    console.log(`the valid sample still gets a warning from the rules of rows: ${stillWarns.join(", ")}`);
  }
}

async function runRoundTrip(opts: Map<string, string>): Promise<void> {
  const report = await roundTrip(need(opts, "transform"), opts.get("template"), opts.get("sheet"));
  const dir = opts.get("out");
  const { imported, transform, sip } = report;
  console.log(`transformation sheet: ${transform.originalRows} original rows, ${transform.regeneratedRows} regenerated rows`);
  console.log(`  cell differences: ${transform.cells.length}`);
  console.log(`  merged ranges only in the original: ${transform.originalOnlyMerges.join(", ") || "none"}`);
  console.log(`  merged ranges only in the regenerated: ${transform.regeneratedOnlyMerges.join(", ") || "none"}`);
  console.log(`  re-importing the regenerated sheet gives the same spec: ${report.specStable}`);
  console.log("  differences by column (wording only / content):");
  console.log(
    `    ${Object.entries(report.differences.byColumn)
      .filter(([, v]) => v.cosmetic + v.content > 0)
      .map(([col, v]) => `${col} ${v.cosmetic}/${v.content}`)
      .join(", ")}`
  );
  for (const d of report.differences.cells.filter((c) => c.kind === "content")) {
    console.log(`    content ${d.address}: ${JSON.stringify(d.original.slice(0, 60))} -> ${JSON.stringify(d.regenerated.slice(0, 60))}`);
  }
  console.log(
    `  logic cells ${imported.logicRows}: fully structured ${imported.parsedRows}, rules with English fragments ${imported.partialRows}, not parsed ${imported.unparsed.length}`
  );
  console.log(`  rejected tag tokens: ${imported.rejectedTokens.length}, unresolved conditions: ${imported.unresolvedConditions.length}`);
  for (const t of imported.rejectedTokens) {
    console.log(`    row ${t.row}: ${JSON.stringify(t.token)}`);
  }
  for (const u of imported.unresolvedConditions) {
    console.log(`    row ${u.row}: ${JSON.stringify(u.label)}`);
  }
  console.log(`SIP: ${sip.rows} key rows, tabs ${sip.formTabs.join(", ")}, rows read back differently ${sip.mismatchedRows}`);
  if (opts.has("template")) {
    console.log(`  differences outside the written regions vs the template: ${sip.untouchedDiffs.length}`);
  }
  for (const c of sip.untouchedDiffs.slice(0, 20)) {
    console.log(`    ${c.address}: ${JSON.stringify(c.original.slice(0, 50))} -> ${JSON.stringify(c.regenerated.slice(0, 50))}`);
  }
  if (dir) {
    save(join(dir, "spec.json"), `${JSON.stringify(report.bundle, null, 2)}\n`);
    save(join(dir, "transformation.xlsx"), new Uint8Array((await report.outputs.transform.xlsx.writeBuffer()) as ArrayBuffer));
    save(join(dir, "sip.xlsx"), new Uint8Array((await report.outputs.sip.xlsx.writeBuffer()) as ArrayBuffer));
    save(
      join(dir, "raw-diff.txt"),
      report.differences.cells
        .map((d) => `## ${d.address} ${TRANSFORM_COLUMNS[d.column - 1]} [${d.kind}]\n--- original\n${d.original}\n+++ regenerated\n${d.regenerated}\n`)
        .join("\n")
    );
    save(join(dir, "unparsed-logic.txt"), `${imported.unparsed.map((u) => `row ${u.row}\t${u.id}\t${u.keys.join(",")}\t${u.reason}`).join("\n")}\n`);
    console.log(`written to ${dir}`);
  }
}

const commands = new Map<string, (opts: Map<string, string>) => Promise<void>>([
  ["import", runImport],
  ["from-pdf", runFromPdf],
  ["generate", runGenerate],
  ["drift", runDrift],
  ["codegen", runCodegen],
  ["roundtrip", runRoundTrip]
]);

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : commands.get(command);
  if (!run) {
    console.error(USAGE);
    return 2;
  }
  try {
    await run(options(rest));
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
