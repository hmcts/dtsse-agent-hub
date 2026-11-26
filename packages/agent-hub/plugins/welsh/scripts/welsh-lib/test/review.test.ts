import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// A catalogue worked on in place, as a change is in its worktree: "Back" has two renderings to review, "Sign out" an
// approved one and one to review, "Continue" none.
const ws = realpathSync(mkdtempSync(join(tmpdir(), "welsh-review-ws-")));
process.env.CFT_WELSH_WORKSPACE = ws;
mkdirSync(join(ws, "apps", "pcs"), { recursive: true });
const welsh = join(ws, "welsh");
mkdirSync(welsh);
process.env.CFT_WELSH_HOME = welsh;
const csv = [
  "id,english,welsh,context,notes,source,received,status",
  "aaaaaaaaa1,Continue,Parhau,,,legacy:a.xlsx,2026-11-25,approved",
  "bbbbbbbbb1,Back,Yn ôl,,More than one rendering,legacy:a.xlsx,2026-11-25,needs-review",
  "bbbbbbbbb2,Back,Nôl,,More than one rendering,legacy:b.xlsx,2026-11-25,needs-review",
  "ccccccccc1,Sign out,Allgofnodi,,,legacy:a.xlsx,2026-11-25,approved",
  "ccccccccc2,Sign out,Allgofnodwch,,Differs from the approved Welsh,legacy:b.xlsx,2026-11-25,needs-review",
  "ddddddddd1,Old,Hen,,,legacy:a.xlsx,2026-11-25,superseded"
].join("\r\n");
const reset = () => writeFileSync(join(welsh, "catalogue.csv"), `${csv}\r\n`);

const { reviewCmd } = await import("../commands/review.ts");
const status = () =>
  Object.fromEntries(
    readFileSync(join(welsh, "catalogue.csv"), "utf8")
      .trim()
      .split(/\r?\n/)
      .slice(1)
      .map((line) => [line.slice(0, 10), line.split(",").at(-1)])
  );

test("a list gives each English with Welsh to review, with every rendering not superseded, the approved one included", async () => {
  reset();
  const result = (await reviewCmd(["--service", "pcs"])) as { total: number; groups: { english: string; why: string[]; options: { id: string }[] }[] };
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.groups.map((g) => [g.english, g.options.map((o) => o.id), g.why]),
    [
      ["Back", ["bbbbbbbbb1", "bbbbbbbbb2"], ["More than one rendering"]],
      ["Sign out", ["ccccccccc1", "ccccccccc2"], ["Differs from the approved Welsh"]]
    ]
  );
});

test("approving a row supersedes every other rendering of its English, and rebuilds the review list", async () => {
  reset();
  const result = (await reviewCmd(["--service", "pcs", "--approve", "bbbbbbbbb2", "--approve", "ccccccccc2"])) as { superseded: number; left: number };
  assert.equal(result.superseded, 2);
  assert.equal(result.left, 0);
  assert.deepEqual(status(), {
    aaaaaaaaa1: "approved",
    bbbbbbbbb1: "superseded",
    bbbbbbbbb2: "approved",
    ccccccccc1: "superseded",
    ccccccccc2: "approved",
    ddddddddd1: "superseded"
  });
  assert.match(readFileSync(join(welsh, "needs-review.md"), "utf8"), /0 English string\(s\) have Welsh/);
});

test("approving the Welsh already approved keeps it, and supersedes the rendering that was waiting", async () => {
  reset();
  await reviewCmd(["--service", "pcs", "--approve", "ccccccccc1"]);
  assert.equal(status().ccccccccc1, "approved");
  assert.equal(status().ccccccccc2, "superseded");
});

test("approving refuses a row that is not waiting for review, one that is not there, and two for one English", async () => {
  reset();
  await assert.rejects(reviewCmd(["--service", "pcs", "--approve", "aaaaaaaaa1"]), /"Continue"\) has nothing waiting for review/);
  await assert.rejects(reviewCmd(["--service", "pcs", "--approve", "zzzzzzzzz9"]), /no catalogue row zzzzzzzzz9/);
  await assert.rejects(reviewCmd(["--service", "pcs", "--approve", "ddddddddd1"]), /nothing waiting for review/);
  await assert.rejects(reviewCmd(["--service", "pcs", "--approve", "bbbbbbbbb1", "--approve", "bbbbbbbbb2"]), /two of those rows are for the same English/);
  assert.equal(status().bbbbbbbbb1, "needs-review", "nothing is changed by a refusal");
});
