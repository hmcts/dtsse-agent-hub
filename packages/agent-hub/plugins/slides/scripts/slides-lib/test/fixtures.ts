import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import type { Outline } from "../masters.ts";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid grey PNG of the given size, so a test has a real picture with known proportions. */
export function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x88)]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const made: string[] = [];

after(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory holding `picture.png` (40 × 20) for outlines to point at, removed once the test file has run. */
export function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "slides-test-"));
  made.push(dir);
  writeFileSync(join(dir, "picture.png"), png(40, 20));
  return dir;
}

/** An outline that uses every layout. */
export function everyLayout(): Outline {
  return {
    title: "Ways of working",
    subtitle: "A developer's guide",
    notes: "Welcome",
    slides: [
      { id: "part-1", layout: "HMCTS_SECTION", title: "Why it matters" },
      {
        id: "what",
        layout: "HMCTS_CONTENT",
        title: "Why does it matter?",
        bullets: ["The team decides", { text: "Templates", bullets: ["Scrum", "Kanban"] }],
        notes: "Say this"
      },
      { layout: "HMCTS_TWO_COLUMN", title: "Ready and done", left: ["Sized"], right: ["Reviewed", "Deployed"] },
      { layout: "HMCTS_IMAGE", title: "The board", image: { path: "picture.png", alt: "A grey rectangle" }, caption: "Our board" },
      { layout: "HMCTS_IMAGE", title: "A divider", image: { path: "picture.png", decorative: true } },
      { layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "#our-channel" }
    ]
  };
}
