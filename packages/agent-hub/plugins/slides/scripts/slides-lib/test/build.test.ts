import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { writeDeck } from "../build.ts";
import { everyLayout, workDir } from "./fixtures.ts";

async function built(): Promise<JSZip> {
  const dir = workDir();
  const out = join(dir, "deck.pptx");
  await writeDeck(everyLayout(), dir, out);
  return JSZip.loadAsync(readFileSync(out));
}

const read = (zip: JSZip, name: string): Promise<string> => {
  const file = zip.file(name);
  assert.ok(file, `${name} is in the deck`);
  return file.async("string");
};

/** Each slide layout's name, by its part name. */
async function layoutNames(zip: JSZip): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const part of Object.keys(zip.files).filter((name) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(name))) {
    names.set(part.replace("ppt/", "../"), (await read(zip, part)).match(/<p:cSld name="([^"]+)"/)?.[1] ?? "");
  }
  return names;
}

const byNumber = (a: string, b: string): number => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]);

async function slideParts(zip: JSZip): Promise<string[]> {
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(byNumber);
}

test("should write a slide master with every HMCTS layout as a named slide layout", async () => {
  const zip = await built();
  assert.ok(zip.file("ppt/slideMasters/slideMaster1.xml"));
  const names = [...(await layoutNames(zip)).values()];
  for (const name of ["HMCTS_TITLE", "HMCTS_SECTION", "HMCTS_CONTENT", "HMCTS_TWO_COLUMN", "HMCTS_IMAGE", "HMCTS_CLOSING"]) {
    assert.ok(names.includes(name), `${name} is one of ${names.join(", ")}`);
  }
  const content = await read(zip, `ppt/slideLayouts/slideLayout${names.indexOf("HMCTS_CONTENT") + 1}.xml`);
  assert.match(content, /<p:cNvPr id="\d+" name="title">[\s\S]*?type="title"/);
  assert.match(content, /<p:cNvPr id="\d+" name="body">[\s\S]*?type="body"/);
  assert.match(content, /<a:srgbClr val="073763"\/>/);
});

test("should base each slide on its layout and fill its placeholders", async () => {
  const zip = await built();
  const names = await layoutNames(zip);
  const parts = await slideParts(zip);
  const layouts: string[] = [];
  for (const part of parts) {
    const rels = await read(zip, part.replace("slides/", "slides/_rels/").replace(".xml", ".xml.rels"));
    layouts.push(names.get(rels.match(/Target="(\.\.\/slideLayouts\/slideLayout\d+\.xml)"/)?.[1] ?? "") ?? "");
  }
  assert.deepEqual(layouts, ["HMCTS_TITLE", "HMCTS_SECTION", "HMCTS_CONTENT", "HMCTS_TWO_COLUMN", "HMCTS_IMAGE", "HMCTS_IMAGE", "HMCTS_CLOSING"]);

  const content = await read(zip, parts[2]);
  assert.match(content, /name="title">[\s\S]*?<p:ph[^>]*type="title"[\s\S]*?<a:t>Why does it matter\?<\/a:t>/);
  assert.match(content, /name="body">[\s\S]*?<p:ph[^>]*type="body"/);
  assert.deepEqual(
    [...content.matchAll(/<a:pPr([^>]*)>[\s\S]*?<a:buChar char="([^"]+)"\/>[\s\S]*?<a:t>([^<]*)<\/a:t>/g)].map((m) => [m[3], m[2], /lvl="1"/.test(m[1])]),
    [
      ["The team decides", "&#x25CF;", false],
      ["Templates", "&#x25CF;", false],
      ["Scrum", "&#x25CB;", true],
      ["Kanban", "&#x25CB;", true]
    ]
  );
  assert.match(content, /indent="-342900"/);

  const twoColumn = await read(zip, parts[3]);
  assert.match(twoColumn, /name="left">[\s\S]*?<a:t>Sized<\/a:t>/);
  assert.match(twoColumn, /name="right">[\s\S]*?<a:t>Reviewed<\/a:t>[\s\S]*?<a:t>Deployed<\/a:t>/);
});

test("should put a picture into its placeholder with its alt text, and mark a decorative one", async () => {
  const zip = await built();
  const parts = await slideParts(zip);
  const picture = await read(zip, parts[4]);
  assert.match(picture, /<p:pic>[\s\S]*?descr="A grey rectangle"[\s\S]*?<p:ph[^>]*idx="\d+"/);
  assert.match(picture, /name="caption">[\s\S]*?<a:t>Our board<\/a:t>/);
  const decorative = await read(zip, parts[5]);
  assert.match(decorative, /descr=""><a:extLst><a:ext uri="\{C183D7F6-B498-43B3-948B-1728B52AA6E4\}"><adec:decorative [^>]*val="1"\/>/);
  assert.doesNotMatch(decorative, /picture\.png/);
});

test("should put the HMCTS artwork behind the title and closing layouts", async () => {
  const zip = await built();
  const media = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/") && !zip.files[name].dir);
  const artwork = readFileSync(fileURLToPath(new URL("../assets/hmcts-title-background.png", import.meta.url)));
  const same = await Promise.all(media.map(async (name) => (await (zip.file(name) as JSZip.JSZipObject).async("nodebuffer")).equals(artwork)));
  assert.ok(same.filter(Boolean).length >= 1);
});

test("should keep speaker notes, and leave the body's paragraphs no extra space before", async () => {
  const zip = await built();
  const notes = await Promise.all(
    Object.keys(zip.files)
      .filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name))
      .map((name) => read(zip, name))
  );
  assert.ok(notes.some((xml) => xml.includes("<a:t>Say this</a:t>")));
  assert.ok(notes.some((xml) => xml.includes("<a:t>Welcome</a:t>")));
  const master = await read(zip, "ppt/slideMasters/slideMaster1.xml");
  assert.doesNotMatch(master.match(/<p:bodyStyle>[\s\S]*?<\/p:bodyStyle>/)?.[0] ?? "", /spcPct val="20000"/);
});

test("should build from the command line, warn on stderr and print the result as JSON", () => {
  const dir = workDir();
  const outline = { ...everyLayout(), slides: [{ layout: "HMCTS_SECTION", title: "one two three four five six seven" }] };
  writeFileSync(join(dir, "outline.json"), JSON.stringify(outline));
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  const stdout = execFileSync(process.execPath, ["--no-warnings", cli, "build", join(dir, "outline.json"), "--out", join(dir, "out.pptx")], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = JSON.parse(stdout);
  assert.equal(result.slides, 2);
  assert.deepEqual(result.warnings, ["slides[0].title has 7 words; the placeholder fits 6"]);
});

test("should exit 2 and print the errors as JSON when the outline cannot be built", () => {
  const dir = workDir();
  writeFileSync(join(dir, "outline.json"), JSON.stringify({ title: "T", slides: [{ layout: "nope", title: "x" }] }));
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  try {
    execFileSync(process.execPath, ["--no-warnings", cli, "build", join(dir, "outline.json"), "--out", join(dir, "out.pptx")], {
      encoding: "utf8",
      stdio: "pipe"
    });
    assert.fail("the build should have failed");
  } catch (err) {
    const failed = err as { status: number; stdout: string };
    assert.equal(failed.status, 2);
    assert.match(JSON.parse(failed.stdout).errors[0], /layout "nope" is not a layout/);
  }
});

test("should print every layout with its fields and limits", () => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  const { layouts } = JSON.parse(execFileSync(process.execPath, ["--no-warnings", cli, "layouts"], { encoding: "utf8" }));
  const content = layouts.find((layout: { name: string }) => layout.name === "HMCTS_CONTENT");
  assert.deepEqual(content.fields.bullets, {
    kind: "bullets",
    required: true,
    description: "Strings, or {text, bullets: [strings]} for one nested level",
    maxWords: 12,
    maxItems: 6
  });
});
