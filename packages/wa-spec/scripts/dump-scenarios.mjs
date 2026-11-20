#!/usr/bin/env node
// Regenerates test-fixtures/<name>-scenarios/ from a service's own Java DMN tests, with Camunda as the oracle.
//
// It adds a throwaway worktree of the service's task-configuration clone, makes the base test's `evaluateDmnTable` and
// `evaluateRequiredDecision` write every input and result as JSON, runs the tests, and splits the dump into one fixture per
// decision. Nothing is committed in the service and the worktree is removed afterwards. The base test is the class
// `DmnDecisionTableBaseUnitTest`, which ET, sscs, civil and prl share.
//
//   node scripts/dump-scenarios.mjs <name> <task-configuration clone> [--max-bytes N]
//
// The instant is recorded as `dumpedAt`, since a DMN that reads today() or now() gives different answers on another day. A scenario
// that repeats an earlier one's input is dropped. When a decision's fixture would pass --max-bytes, every second scenario is
// dropped, repeatedly, until it fits. The spec the service's DMNs import to is written beside the fixtures as spec.yaml, headed
// with the commit it came from, so the scenarios can be run without the clone.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [name, clone, flag, limit] = process.argv.slice(2);
if (!name || !clone) {
  console.error("usage: dump-scenarios.mjs <name> <task-configuration clone> [--max-bytes N]");
  process.exit(2);
}
if (flag !== undefined && (flag !== "--max-bytes" || !(Number(limit) > 0))) {
  console.error("--max-bytes needs a positive number of bytes");
  process.exit(2);
}
const maxBytes = flag === undefined ? Number.POSITIVE_INFINITY : Number(limit);
const out = fileURLToPath(new URL(`../test-fixtures/${name}-scenarios`, import.meta.url));
const work = mkdtempSync(join(tmpdir(), `${name}-dump-`));
const worktree = join(work, "clone");
const dump = join(work, "dump.jsonl");
const dumpedAt = new Date().toISOString();
const sha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"]).toString().trim();
const repo = execFileSync("git", ["-C", clone, "remote", "get-url", "origin"])
  .toString()
  .trim()
  .replace(/^.*github\.com[:/]/, "")
  .replace(/\.git$/, "");

/** The decisions a spec represents; a service's own extra tables, such as civil's court location, are left out. */
const TASK_DMN = /^wa-task-(initiation|configuration|permissions|completion|cancellation|types|allowed-days)-/;

const RECORD = `
    private static void dump(DmnDecision evaluated, DmnDecision main, Map<String, Object> variables, DmnDecisionTableResult result) {
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper()
                .findAndRegisterModules()
                .configure(com.fasterxml.jackson.databind.SerializationFeature.FAIL_ON_EMPTY_BEANS, false)
                .configure(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
            java.util.Map<String, Object> record = new java.util.LinkedHashMap<>();
            record.put("decision", main.getKey());
            if (evaluated != main) {
                record.put("required", evaluated.getKey());
                record.put("requiredName", evaluated.getName());
            }
            record.put("input", new java.util.LinkedHashMap<>(variables));
            record.put("output", result.getResultList());
            java.nio.file.Files.writeString(java.nio.file.Path.of(System.getProperty("dmn.dump")),
                mapper.writeValueAsString(record) + "\\n",
                java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
`;

execFileSync("git", ["-C", clone, "worktree", "add", "--detach", worktree, sha], { stdio: "inherit" });
try {
  const base = execFileSync("git", ["-C", worktree, "ls-files", "*DmnDecisionTableBaseUnitTest.java"]).toString().trim().split("\n")[0];
  const path = join(worktree, base);
  const source = readFileSync(path, "utf8");
  const instrumented = source
    .replace(
      /return dmnEngine\.evaluateDecisionTable\(decision, variables\);/,
      "DmnDecisionTableResult result = dmnEngine.evaluateDecisionTable(decision, variables);\n        dump(decision, decision, variables, result);\n        return result;"
    )
    .replace(
      /return requiredDecision\.map\(dmnDecision -> dmnEngine\.evaluateDecisionTable\(\s*dmnDecision,\s*variables\s*\)\)\.orElse\(null\);/,
      "return requiredDecision.map(dmnDecision -> {\n            DmnDecisionTableResult result = dmnEngine.evaluateDecisionTable(dmnDecision, variables);\n            dump(dmnDecision, decision, variables, result);\n            return result;\n        }).orElse(null);"
    )
    .replace(/\}\s*$/, RECORD);
  if (!instrumented.includes("dump(decision, decision")) {
    throw new Error(`${base}: evaluateDmnTable is not the expected shape`);
  }
  if (source.includes("evaluateRequiredDecision") && !instrumented.includes("dump(dmnDecision, decision")) {
    throw new Error(`${base}: evaluateRequiredDecision is not the expected shape, so scenarios for required decisions would be missing`);
  }
  writeFileSync(path, instrumented);
  execFileSync(join(worktree, "gradlew"), ["test", "--rerun-tasks"], {
    cwd: worktree,
    stdio: "inherit",
    env: { ...process.env, JAVA_TOOL_OPTIONS: `-Ddmn.dump=${dump}` }
  });
  const records = readFileSync(dump, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const byDecision = new Map();
  const seen = new Set();
  for (const { decision, required, requiredName, input, output } of records) {
    if (!TASK_DMN.test(decision)) {
      continue;
    }
    const key = JSON.stringify([decision, required, input]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    byDecision.set(decision, [...(byDecision.get(decision) ?? []), { ...(required ? { required, requiredName } : {}), input, output }]);
  }
  mkdirSync(out, { recursive: true });
  for (const old of readdirSync(out).filter((f) => f.endsWith(".json"))) {
    rmSync(join(out, old));
  }
  const dmns = join(work, "dmns");
  mkdirSync(dmns);
  for (const file of readdirSync(join(worktree, "src/main/resources")).filter((f) => /^wa-task-.*\.dmn$/.test(f))) {
    copyFileSync(join(worktree, "src/main/resources", file), join(dmns, file));
  }
  const imported = join(work, "spec.yaml");
  execFileSync(fileURLToPath(new URL("../bin/wa-spec", import.meta.url)), ["import", dmns, "-o", imported], { stdio: "inherit" });
  writeFileSync(join(out, "spec.yaml"), `# Imported by wa-spec from the DMNs of ${repo}@${sha}\n${readFileSync(imported, "utf8")}`);
  const total = { kept: 0, seen: seen.size };
  for (const [decision, scenarios] of [...byDecision].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let kept = scenarios;
    const render = () => `${JSON.stringify({ decision, source: `${repo}@${sha}`, dumpedAt, scenarios: kept }, null, 1)}\n`;
    while (render().length > maxBytes && kept.length > 1) {
      kept = kept.filter((_, i) => i % 2 === 0);
    }
    total.kept += kept.length;
    writeFileSync(join(out, `${decision}.json`), render());
  }
  console.log(`${name}: ${total.kept} of ${total.seen} distinct scenarios across ${byDecision.size} decisions written to ${out}`);
} finally {
  execFileSync("git", ["-C", clone, "worktree", "remove", "--force", worktree], { stdio: "inherit" });
  rmSync(work, { recursive: true, force: true });
}
