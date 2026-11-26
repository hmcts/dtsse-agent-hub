import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A stand-in gh, first on PATH before the engine looks for it, that writes down each search and finds an open pull
// request only in hmcts/repo-17.
const bin = mkdtempSync(join(tmpdir(), "welsh-gh-"));
const calls = join(bin, "calls");
writeFileSync(calls, "");
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$*" in *repo:hmcts/repo-17*) echo "https://github.com/hmcts/repo-17/pull/5" ;; esac
`
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { openPrTitled } = await import("../commands/setup.ts");
const { mkdirSync } = await import("node:fs");

test("open pull requests are looked for in as few searches as fit GitHub's query limit, not one per repo", () => {
  const urls = Array.from({ length: 20 }, (_, i) => `hmcts/repo-${i + 1}`);
  assert.equal(openPrTitled("Welsh catalogue: set up civil", urls), "https://github.com/hmcts/repo-17/pull/5");
  const searches = readFileSync(calls, "utf8").trim().split("\n");
  assert.ok(searches.length > 1 && searches.length <= 3, `${searches.length} searches`);
  assert.ok(searches.every((s) => s.startsWith("search prs --state open") && s.includes('"Welsh catalogue: set up civil" in:title')));
  assert.ok(
    searches.every((s) => s.length <= 330),
    "each query fits"
  );
});

test("no repo, or a search that finds nothing, is no open pull request", () => {
  assert.equal(openPrTitled("Welsh catalogue: set up civil", []), null);
  assert.equal(openPrTitled("Welsh catalogue: set up civil", ["hmcts/repo-1"]), null);
});

test("a review is refused while another for the service is waiting to be merged, and the list links to it", async () => {
  const ws = mkdtempSync(join(tmpdir(), "welsh-review-open-"));
  process.env.CFT_WELSH_WORKSPACE = ws;
  writeFileSync(join(ws, "workspace.yaml"), "repos:\n  apps/pcs/repo-17: { url: hmcts/repo-17 }\n");
  const welsh = join(ws, "apps", "pcs", "repo-17", "welsh");
  mkdirSync(welsh, { recursive: true });
  writeFileSync(join(welsh, "config.yaml"), "repos: []\n");
  writeFileSync(
    join(welsh, "catalogue.csv"),
    "id,english,welsh,context,notes,source,received,status\r\nbbbbbbbbb1,Back,Yn ôl,,,legacy:a.xlsx,2026-11-25,needs-review\r\nbbbbbbbbb2,Back,Nôl,,,legacy:b.xlsx,2026-11-25,needs-review\r\n"
  );
  const { reviewCmd } = await import("../commands/review.ts");
  const listed = (await reviewCmd(["--service", "pcs"])) as { openPr: string | null; total: number };
  assert.equal(listed.total, 1);
  assert.equal(listed.openPr, "https://github.com/hmcts/repo-17/pull/5");
  await assert.rejects(reviewCmd(["--service", "pcs", "--approve", "bbbbbbbbb1"]), /waiting to be merged: https:\/\/github.com\/hmcts\/repo-17\/pull\/5/);
  assert.match(readFileSync(calls, "utf8"), /"Welsh catalogue: pcs approves" in:title/);
});
