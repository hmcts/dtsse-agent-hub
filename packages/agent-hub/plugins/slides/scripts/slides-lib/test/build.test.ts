import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DeckError, writeDeck } from "../build.ts";
import { everyLayout, png, workDir } from "./fixtures.ts";

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

/** The XML of the slide layout named `name`. */
async function layoutNamed(zip: JSZip, name: string): Promise<string> {
  const part = [...(await layoutNames(zip)).entries()].find(([, layout]) => layout === name)?.[0];
  assert.ok(part, `there is a layout named ${name}`);
  return read(zip, part.replace("../", "ppt/"));
}

/** A placeholder's shape in a layout, by the placeholder's name. */
function shapeNamed(layout: string, name: string): string {
  const shape = layout.match(/<p:sp>[\s\S]*?<\/p:sp>/g)?.find((sp) => sp.includes(`name="${name}"`));
  assert.ok(shape, `the layout has a placeholder named ${name}`);
  return shape;
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
  const content = await layoutNamed(zip, "HMCTS_CONTENT");
  assert.match(content, /<p:cNvPr id="\d+" name="title">[\s\S]*?type="title"/);
  assert.match(content, /<p:cNvPr id="\d+" name="body">[\s\S]*?type="body"/);
  assert.match(content, /<a:srgbClr val="073763"\/>/);
});

test("should give each layout's bullet placeholders the deck's two bullet levels, so text typed into one is bulleted", async () => {
  const zip = await built();
  const lists: [string, string][] = [
    ["HMCTS_CONTENT", "body"],
    ["HMCTS_TWO_COLUMN", "left"],
    ["HMCTS_TWO_COLUMN", "right"]
  ];
  for (const [layout, name] of lists) {
    const style = shapeNamed(await layoutNamed(zip, layout), name).match(/<a:lstStyle>([\s\S]*?)<\/a:lstStyle>/)?.[1] ?? "";
    const level = (n: number) => style.match(new RegExp(`<a:lvl${n}pPr([^>]*)>([\\s\\S]*?)</a:lvl${n}pPr>`));
    const first = level(1);
    const second = level(2);
    assert.ok(first && second, `${layout} ${name} has both levels: ${style}`);
    assert.match(first[1], /marL="457200" indent="-342900"/);
    assert.match(first[2], /<a:buChar char="&#x25CF;"\/>/);
    assert.match(second[1], /marL="914400" indent="-342900"/);
    assert.match(second[2], /<a:buChar char="&#x25CB;"\/>/);
    for (const [, , body] of [first, second]) {
      assert.doesNotMatch(body, /buNone/);
      assert.match(body, /<a:spcPct val="150000"\/>[\s\S]*sz="1800"/);
    }
  }
  const title = shapeNamed(await layoutNamed(zip, "HMCTS_CONTENT"), "title");
  assert.doesNotMatch(title, /buChar|lvl2pPr/);
});

test("should leave out the blank DEFAULT layout pptxgenjs adds, and every reference to it", async () => {
  const zip = await built();
  const names = await layoutNames(zip);
  assert.deepEqual([...names.values()].sort(), ["HMCTS_CLOSING", "HMCTS_CONTENT", "HMCTS_IMAGE", "HMCTS_SECTION", "HMCTS_TITLE", "HMCTS_TWO_COLUMN"]);
  const rels = await read(zip, "ppt/slideMasters/_rels/slideMaster1.xml.rels");
  const targets = [...rels.matchAll(/Target="(\.\.\/slideLayouts\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets.sort(), [...names.keys()].sort());
  const master = await read(zip, "ppt/slideMasters/slideMaster1.xml");
  const ids = [...master.matchAll(/<p:sldLayoutId id="\d+" r:id="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.equal(ids.length, names.size);
  for (const id of ids) {
    assert.match(rels, new RegExp(`Id="${id}" Type="[^"]+/slideLayout"`));
  }
  const types = await read(zip, "[Content_Types].xml");
  const overridden = [...types.matchAll(/PartName="\/(ppt\/slideLayouts\/[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(overridden.sort(), [...names.keys()].map((part) => part.replace("../", "ppt/")).sort());
  for (const name of Object.keys(zip.files).filter((file) => file.startsWith("ppt/slideLayouts/") && !zip.files[file].dir)) {
    const part = name.replace("_rels/", "").replace(/\.rels$/, "");
    assert.ok(overridden.includes(part), `${name} belongs to a layout that is listed`);
  }
});

test("should give a picture the content type of its bytes when its name has a ? in it", async () => {
  const dir = workDir();
  writeFileSync(join(dir, "what?.png"), png(30, 30));
  const outline = { title: "T", slides: [{ layout: "HMCTS_IMAGE", title: "P", image: { path: "what?.png", alt: "A square" } }] };
  const staged = () => readdirSync(tmpdir()).filter((name) => name.startsWith("slides-pictures-"));
  const before = staged();
  await writeDeck(outline, dir, join(dir, "deck.pptx"));
  assert.deepEqual(staged(), before);
  const zip = await JSZip.loadAsync(readFileSync(join(dir, "deck.pptx")));
  const media = Object.keys(zip.files).filter((name) => name.startsWith("ppt/media/") && !zip.files[name].dir);
  const picture = await Promise.all(
    media.map(async (name) => ((await (zip.file(name) as JSZip.JSZipObject).async("nodebuffer")).equals(png(30, 30)) ? name : null))
  );
  const [part] = picture.filter((name) => name !== null);
  assert.match(part ?? "", /\.png$/);
  const types = await read(zip, "[Content_Types].xml");
  assert.match(types, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.doesNotMatch(types, /Extension="what"/);
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
    maxWords: 7,
    maxLines: 1,
    maxItems: 6
  });
});

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
  try {
    const stdout = execFileSync(process.execPath, ["--no-warnings", cli, ...args], { encoding: "utf8", stdio: "pipe" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return err as { status: number; stdout: string; stderr: string };
  }
}

test("should say --out is required, exit 2 and print the error as JSON, when the outline is given without it", () => {
  const dir = workDir();
  writeFileSync(join(dir, "outline.json"), JSON.stringify(everyLayout()));
  const { status, stdout } = runCli(["build", join(dir, "outline.json")]);
  assert.equal(status, 2);
  assert.deepEqual(JSON.parse(stdout), { errors: ["--out <file.pptx> is required"] });
});

test("should exit 2 and print the error as JSON when the deck cannot be written where --out says", () => {
  const dir = workDir();
  writeFileSync(join(dir, "outline.json"), JSON.stringify(everyLayout()));
  const out = join(dir, "missing", "deck.pptx");
  const { status, stdout } = runCli(["build", join(dir, "outline.json"), "--out", out]);
  assert.equal(status, 2);
  const { errors } = JSON.parse(stdout);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^cannot write ${out}: ENOENT`));
});

test("should exit 2 and print the error as JSON when the command is not one there is", () => {
  const { status, stdout } = runCli(["nope"]);
  assert.equal(status, 2);
  assert.deepEqual(JSON.parse(stdout), { errors: ["there is no command nope"] });
});

test("should exit 2 and print the error as JSON when the command is a name every object inherits", () => {
  for (const command of ["constructor", "__proto__", "toString"]) {
    const { status, stdout } = runCli([command]);
    assert.equal(status, 2, command);
    assert.deepEqual(JSON.parse(stdout), { errors: [`there is no command ${command}`] });
  }
});

test("should throw a DeckError naming the picture when one cannot be read", async () => {
  const dir = workDir();
  writeFileSync(join(dir, "picture.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await assert.rejects(writeDeck(everyLayout(), dir, join(dir, "deck.pptx")), (err: unknown) => err instanceof DeckError && /picture\.png/.test(err.message));
});
