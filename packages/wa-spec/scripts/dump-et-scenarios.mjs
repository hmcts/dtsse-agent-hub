#!/usr/bin/env node
// Regenerates test-fixtures/et-scenarios/ from ET's own Java DMN tests, with Camunda as the oracle.
//
// It adds a throwaway worktree of et-wa-task-configuration, makes DmnDecisionTableBaseUnitTest write every
// evaluateDecisionTable input and result to a JSON-lines file, runs the tests, and splits the dump into one fixture per
// decision. Nothing is committed in ET and the worktree is removed afterwards.
//
//   node scripts/dump-et-scenarios.mjs <path to et-wa-task-configuration clone>
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const clone = process.argv[2];
if (!clone) {
  console.error("usage: dump-et-scenarios.mjs <et-wa-task-configuration clone>");
  process.exit(2);
}
const out = fileURLToPath(new URL("../test-fixtures/et-scenarios", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "et-dump-"));
const worktree = join(work, "et");
const dump = join(work, "dump.jsonl");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const sha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"]).toString().trim();

run("git", ["-C", clone, "worktree", "add", "--detach", worktree, sha]);
try {
  const base = join(worktree, "src/test/java/uk/gov/hmcts/et/taskconfiguration/DmnDecisionTableBaseUnitTest.java");
  const source = readFileSync(base, "utf8");
  const instrumented = source
    .replace(
      "return dmnEngine.evaluateDecisionTable(decision, variables);",
      "DmnDecisionTableResult result = dmnEngine.evaluateDecisionTable(decision, variables);\n        dump(variables, result);\n        return result;"
    )
    .replace(
      /\}\s*$/,
      `
    private void dump(Map<String, Object> variables, DmnDecisionTableResult result) {
        try {
            com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper()
                .findAndRegisterModules()
                .configure(com.fasterxml.jackson.databind.SerializationFeature.FAIL_ON_EMPTY_BEANS, false)
                .configure(com.fasterxml.jackson.databind.SerializationFeature.WRITE_DATES_AS_TIMESTAMPS, false);
            java.util.Map<String, Object> record = new java.util.LinkedHashMap<>();
            record.put("decision", CURRENT_DMN_DECISION_TABLE.getKey());
            record.put("test", getClass().getSimpleName());
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
`
    );
  writeFileSync(base, instrumented);
  const gradle = join(worktree, "gradlew");
  execFileSync(gradle, ["test", "--rerun-tasks"], { cwd: worktree, stdio: "inherit", env: { ...process.env, JAVA_TOOL_OPTIONS: `-Ddmn.dump=${dump}` } });
  const records = readFileSync(dump, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const byDecision = new Map();
  const seen = new Set();
  for (const { decision, test, input, output } of records) {
    const key = JSON.stringify([decision, input]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    byDecision.set(decision, [...(byDecision.get(decision) ?? []), { test, input, output }]);
  }
  mkdirSync(out, { recursive: true });
  for (const [decision, scenarios] of [...byDecision].sort(([a], [b]) => (a < b ? -1 : 1))) {
    writeFileSync(join(out, `${decision}.json`), `${JSON.stringify({ decision, source: `hmcts/et-wa-task-configuration@${sha}`, scenarios }, null, 1)}\n`);
  }
  console.log(`${seen.size} distinct scenarios across ${byDecision.size} decisions written to ${out}`);
} finally {
  run("git", ["-C", clone, "worktree", "remove", "--force", worktree]);
  rmSync(work, { recursive: true, force: true });
}
