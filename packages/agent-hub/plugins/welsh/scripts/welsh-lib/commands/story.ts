/**
 * story: add or refresh the "Welsh content" section of a Jira story.
 *
 *   story KEY --service X                      list candidate English strings (read-only)
 *   story KEY --service X --strings f.txt      build a preview from the BA's confirmed list
 *   story KEY --service X --candidates         ...or from every candidate
 *   story KEY --service X --refresh            ...or from the strings already in the section
 *   story KEY --service X --write              write the last preview to Jira
 *
 * Nothing reaches Jira without a preview, a clean verify and an unchanged story.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCatalogue, type Row } from "../catalogue.ts";
import { loadConfig } from "../config.ts";
import { fail, requireService, say } from "../io.ts";
import { type AdfNode, fetchStory, updateDescription } from "../jira.ts";
import { saveRequest, workDir } from "../requests.ts";
import { buildRows, candidates, existingRows, markdownPreview, notInStory, type StoryRow, withSection } from "../story.ts";
import { verify } from "../verify.ts";

export async function storyCmd(argv: string[]): Promise<unknown> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      service: { type: "string" },
      strings: { type: "string" },
      candidates: { type: "boolean" },
      refresh: { type: "boolean" },
      choose: { type: "string", multiple: true },
      write: { type: "boolean" },
      out: { type: "string" }
    }
  });
  const key = positionals[0]?.toUpperCase();
  if (!key || !/^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
    fail("give a Jira key, e.g. PUB-1234");
  }
  const service = requireService(values.service);
  const previewPath = join(workDir(service, "stories"), `${key}.json`);

  if (values.write) {
    return write(key, service, previewPath, values.out);
  }

  const story = fetchStory(key);
  const existing = existingRows(story.description);
  const found = candidates(story.description);

  let strings: string[] | null = null;
  if (values.strings) {
    strings = readStrings(values.strings);
  } else if (values.candidates) {
    strings = found.map((c) => c.english);
  } else if (values.refresh) {
    if (!existing.length) {
      fail(`${key} has no "Welsh content" section to refresh`);
    }
    strings = existing.map((r) => r.english);
  }

  if (!strings) {
    say(
      `${key}: ${story.summary}\n` +
        `${found.length} candidate English string(s) found${existing.length ? `; existing Welsh section has ${existing.length} row(s)` : ""}.\n` +
        "Confirm the list with the BA, save it one string per line, then run with --strings <file>."
    );
    return { key, summary: story.summary, url: story.url, candidates: found, existing };
  }

  const missing = notInStory(strings, story.description);
  if (missing.length) {
    fail(`these strings are not in ${key} word for word — copy them from the story:\n  ${missing.join("\n  ")}`);
  }

  const catalogue = loadCatalogue(service);
  const choices = parseChoices(values.choose ?? [], catalogue.rows, service);
  const { rows, handEdited } = buildRows(service, strings, catalogue, existing, choices, loadConfig(service).context_sensitive);
  const check = verify(rows, catalogue);
  const description = withSection(story.description, rows);
  writeFileSync(previewPath, JSON.stringify({ key, service, hash: story.hash, rows, description } satisfies Preview, null, 2));

  const counts = tally(rows);
  say(
    `${key}: ${counts.filled} filled from the catalogue, ${counts.required} need the WLU, ${counts.ambiguous} need a BA choice` +
      (handEdited.length ? `, ${handEdited.length} hand-edited` : "") +
      ".\n\n" +
      markdownPreview(rows) +
      "\n\n" +
      (check.ok
        ? `Preview saved. Write it to Jira with: welsh story ${key} --service ${service} --write`
        : `verify FAILED — this cannot be written:\n${check.failures.map((f) => `  - "${f.english}" → "${f.welsh}": ${f.reason}`).join("\n")}\n` +
          "Welsh typed into the story by hand must be added to the catalogue from a WLU return first (welsh import).")
  );
  return { key, service, preview: previewPath, counts, verify: check, rows };
}

async function write(key: string, service: string, previewPath: string, out: string | undefined): Promise<unknown> {
  if (!existsSync(previewPath)) {
    fail(`no preview for ${key} — run without --write first`);
  }
  const preview = JSON.parse(readFileSync(previewPath, "utf8")) as Preview;

  const check = verify(preview.rows, loadCatalogue(service));
  if (!check.ok) {
    fail(`verify failed for ${check.failures.length} row(s); rebuild the preview after fixing the catalogue`);
  }

  const current = fetchStory(key);
  if (current.hash !== preview.hash) {
    fail(`${key} has changed since the preview was built — rebuild it so those edits are kept`);
  }

  updateDescription(key, preview.description);

  const toWlu = preview.rows.filter((r) => r.state === "required");
  const request = toWlu.length
    ? await saveRequest(
        service,
        key,
        toWlu.map((r) => ({ ref: r.ref, english: r.english, context: `Jira ${key}`, notes: "" })),
        out ? resolve(out) : undefined
      )
    : null;
  say(
    `Updated ${current.url}.` +
      (request ? `\n${toWlu.length} string(s) need the WLU — send them ${request}` : "\nEvery string has approved Welsh; nothing to send.")
  );
  return { key, updated: true, url: current.url, request, counts: tally(preview.rows) };
}

/** --choose REF=ROW-ID: the BA picks one of several approved catalogue renderings. */
function parseChoices(raw: string[], rows: Row[], service: string): Map<string, Row> {
  const choices = new Map<string, Row>();
  for (const pair of raw) {
    const [ref, id] = pair.split("=");
    const row = rows.find((r) => r.id === id && r.status === "approved");
    if (!ref || !row) {
      fail(`--choose ${pair}: no approved catalogue row ${id} in ${service}`);
    }
    choices.set(ref, row);
  }
  return choices;
}

function readStrings(path: string): string[] {
  const text = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ];
}

function tally(rows: StoryRow[]) {
  const n = (s: StoryRow["state"]) => rows.filter((r) => r.state === s).length;
  return { total: rows.length, filled: n("filled"), required: n("required"), ambiguous: n("ambiguous"), handEdited: n("hand-edited") };
}

interface Preview {
  key: string;
  service: string;
  hash: string;
  rows: StoryRow[];
  description: AdfNode;
}
