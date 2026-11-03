import { describe, expect, it } from "vitest";
import {
  assetRef,
  assetSha,
  checkOutline,
  type DeckOutline,
  imageInfo,
  isPptx,
  isSha256,
  jsonbText,
  MAX_IMAGE_SIDE,
  MAX_OUTLINE_BYTES,
  newSlideId,
  outlineAssets,
  plannable,
  SLIDE_SCHEMAS,
  slideReference,
  withSlideIds
} from "./deck.ts";
import { MASTERS, plan } from "./slides/masters.ts";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);

function outline(overrides: Partial<DeckOutline> = {}): DeckOutline {
  return {
    title: "Ways of working",
    subtitle: "A guide",
    notes: "Welcome",
    slides: [
      { id: "why", layout: "HMCTS_SECTION", title: "Why it matters" },
      { layout: "HMCTS_CONTENT", title: "What to do", bullets: ["One", { text: "Two", bullets: ["Two a"] }], notes: "Say this" },
      { layout: "HMCTS_TWO_COLUMN", title: "Before and after", left: ["Slow"], right: ["Fast"] },
      { layout: "HMCTS_IMAGE", title: "Pipeline", image: { asset: assetRef(SHA), alt: "The pipeline" }, caption: "Every stage" },
      { layout: "HMCTS_IMAGE", title: "Skyline", image: { asset: assetRef(OTHER), decorative: true } },
      { layout: "HMCTS_IMAGE", title: "Pipeline again", image: { asset: assetRef(SHA), alt: "The same pipeline" } },
      { layout: "HMCTS_CLOSING", title: "Questions?", subtitle: "#team on Slack" }
    ],
    ...overrides
  };
}

/** Draws that never repeat, so the ids `withSlideIds` gives are the same from one call to the next. */
function counter(): () => number {
  let drawn = 0;
  return () => {
    drawn += 1;
    return drawn / 0x10000;
  };
}

function refused(value: unknown): string {
  const result = checkOutline(value);
  if (result.ok) {
    throw new Error("expected the outline to be refused");
  }
  return result.error;
}

describe("SLIDE_SCHEMAS", () => {
  it("should take exactly each slide layout's placeholder fields when compared with the plugin's masters", () => {
    const layouts = MASTERS.filter((master) => master.inSlides);
    expect(Object.keys(SLIDE_SCHEMAS).sort((a, b) => (a < b ? -1 : 1))).toEqual(layouts.map((master) => master.name).sort((a, b) => (a < b ? -1 : 1)));
    for (const master of layouts) {
      const keys = Object.keys(SLIDE_SCHEMAS[master.name as keyof typeof SLIDE_SCHEMAS].shape).sort((a, b) => (a < b ? -1 : 1));
      const fields = ["id", "layout", "notes", ...master.placeholders.map((spec) => spec.field)].sort((a, b) => (a < b ? -1 : 1));
      expect(keys).toEqual(fields);
    }
  });
});

describe("checkOutline", () => {
  it("should accept an outline that uses every layout, with an id on every slide", () => {
    const random = counter();
    expect(checkOutline(outline(), random)).toEqual({ ok: true, outline: withSlideIds(outline(), counter()) });
  });

  it("should refuse a picture named by path when the hub holds pictures by their hash", () => {
    const slides = [{ layout: "HMCTS_IMAGE", title: "Pipeline", image: { path: "pipeline.png", alt: "The pipeline" } }];
    expect(refused({ title: "Deck", slides })).toMatch(/^outline\.slides\[0\]\.image must be \{asset, alt\}/);
  });

  it("should refuse a picture with neither alt text nor decorative when the plugin would refuse to build it", () => {
    const slides = [{ layout: "HMCTS_IMAGE", title: "Pipeline", image: { asset: assetRef(SHA) } }];
    expect(refused({ title: "Deck", slides })).toContain("give alt text");
  });

  it("should refuse an asset that is not a sha256 reference", () => {
    const slides = [{ layout: "HMCTS_IMAGE", title: "Pipeline", image: { asset: "sha256:ABC", alt: "x" } }];
    expect(checkOutline({ title: "Deck", slides }).ok).toBe(false);
  });

  it("should refuse the title slide's layout when it is listed among the slides", () => {
    expect(refused({ title: "Deck", slides: [{ layout: "HMCTS_TITLE", title: "Again" }] })).toContain("layout must be one of HMCTS_SECTION");
  });

  it("should refuse a field the layout does not take", () => {
    expect(refused({ title: "Deck", slides: [{ layout: "HMCTS_SECTION", title: "Part", bullets: ["no"] }] })).toContain("outline.slides[0]");
  });

  it("should refuse bullets nested more than one level", () => {
    const slides = [{ layout: "HMCTS_CONTENT", title: "Deep", bullets: [{ text: "One", bullets: [{ text: "Two" }] }] }];
    expect(checkOutline({ title: "Deck", slides }).ok).toBe(false);
  });

  it("should refuse blank text when a placeholder needs words", () => {
    expect(refused({ title: "  ", slides: [{ layout: "HMCTS_SECTION", title: "Part" }] })).toBe("outline.title must be non-empty text");
  });

  it("should refuse an outline with no slides", () => {
    expect(checkOutline({ title: "Deck", slides: [] }).ok).toBe(false);
  });

  it("should refuse two slides with one id", () => {
    const slides = [
      { id: "a", layout: "HMCTS_SECTION", title: "One" },
      { id: "a", layout: "HMCTS_SECTION", title: "Two" }
    ];
    expect(refused({ title: "Deck", slides })).toBe("outline.slides two slides have the same id");
  });

  it("should refuse an id a slide reference could not carry", () => {
    expect(checkOutline({ title: "Deck", slides: [{ id: "has space", layout: "HMCTS_SECTION", title: "One" }] }).ok).toBe(false);
  });

  it("should refuse an outline larger than the column holds when each field is within its own limit", () => {
    const slides = Array.from({ length: 100 }, (_, index) => ({ layout: "HMCTS_SECTION", title: `Part ${index}`, notes: "n".repeat(2500) }));
    expect(refused({ title: "Deck", slides })).toBe(`the outline is larger than ${MAX_OUTLINE_BYTES} bytes`);
  });

  it("should measure the outline as Postgres prints it, ids and all, when it is at the column's limit", () => {
    // Slides without ids, so the ids the check gives them are part of what it measures.
    const sized = (extra: number): DeckOutline => ({
      title: "Deck",
      notes: "x".repeat(extra),
      slides: Array.from({ length: 20 }, (_, index) => ({ layout: "HMCTS_SECTION" as const, title: `Part ${index}`, notes: "n".repeat(9800) }))
    });
    const stored = (value: DeckOutline) => new TextEncoder().encode(jsonbText(withSlideIds(value, counter())) ?? "").byteLength;
    const fits = MAX_OUTLINE_BYTES - stored(sized(0));
    expect(fits).toBeGreaterThan(0);
    expect(stored(sized(fits))).toBe(MAX_OUTLINE_BYTES);

    expect(checkOutline(sized(fits), counter()).ok).toBe(true);
    expect(refused(sized(fits + 1))).toBe(`the outline is larger than ${MAX_OUTLINE_BYTES} bytes`);
    // What the check used to measure: compact JSON, before the ids. It is well under the limit for the same outline.
    expect(new TextEncoder().encode(JSON.stringify(sized(fits + 1))).byteLength).toBeLessThan(MAX_OUTLINE_BYTES - 100);
  });

  it("should refuse text a jsonb cannot hold when it has a NUL or half a surrogate pair", () => {
    const error = "the outline has text the hub cannot store: a NUL character, or half of a surrogate pair";
    expect(refused(outline({ notes: "a\u0000b" }))).toBe(error);
    expect(refused(outline({ subtitle: "\ud83d" }))).toBe(error);
    expect(refused(outline({ subtitle: "\ude00 alone" }))).toBe(error);
    expect(checkOutline(outline({ subtitle: "\ud83d\ude00 a whole emoji" })).ok).toBe(true);
  });

  it("should say the outline is not valid when it is not an object", () => {
    expect(checkOutline("slides").ok).toBe(false);
  });
});

describe("jsonbText", () => {
  it("should print a value as Postgres prints a jsonb, when keys, arrays and escapes are all in it", () => {
    // `SELECT '{"b":[1,2],"aa":{"x":"é\\n\\u001f"},"c":true}'::jsonb::text` on Postgres 16.
    expect(jsonbText({ b: [1, 2], aa: { x: "é\n\u001f" }, c: true })).toBe('{"b": [1, 2], "c": true, "aa": {"x": "é\\n\\u001f"}}');
    expect(jsonbText({ ab: 1, aa: 2, b: undefined, é: 3, z: 4 })).toBe('{"z": 4, "aa": 2, "ab": 1, "é": 3}');
    expect(jsonbText({ list: [], none: null, nested: {} })).toBe('{"list": [], "none": null, "nested": {}}');
  });

  it("should answer nothing for a value a jsonb cannot hold", () => {
    expect(jsonbText(["fine", "nul\u0000"])).toBeUndefined();
    expect(jsonbText({ "\u0000": "key" })).toBeUndefined();
    expect(jsonbText({ a: { b: "\udfff" } })).toBeUndefined();
  });
});

describe("withSlideIds", () => {
  it("should keep the ids slides came with and give the rest new ones", () => {
    const ids = withSlideIds(outline()).slides.map((one) => one.id);
    expect(ids[0]).toBe("why");
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(1).every((id) => /^s_[0-9a-f]{4}$/.test(id ?? ""))).toBe(true);
  });

  it("should draw again when a new id is already a slide's", () => {
    const draws = [0, 0, 0.5];
    const random = () => draws.shift() ?? 0.75;
    const ids = withSlideIds(
      {
        title: "Deck",
        slides: [
          { id: "s_0000", layout: "HMCTS_SECTION", title: "One" },
          { layout: "HMCTS_SECTION", title: "Two" }
        ]
      },
      random
    ).slides.map((one) => one.id);
    expect(ids).toEqual(["s_0000", "s_8000"]);
  });

  it("should lengthen the id when every short one it draws is taken", () => {
    const slides = [
      { id: "s_0000", layout: "HMCTS_SECTION" as const, title: "One" },
      { layout: "HMCTS_SECTION" as const, title: "Two" }
    ];
    expect(withSlideIds({ title: "Deck", slides }, () => 0).slides[1]?.id).toBe("s_00000000");
  });

  it("should pad a small draw to four digits", () => {
    expect(newSlideId(() => 1 / 0x10000)).toBe("s_0001");
  });
});

describe("assets", () => {
  it("should name each picture once, in order, when two slides use one", () => {
    expect(outlineAssets(outline())).toEqual([SHA, OTHER]);
  });

  it("should read the digest out of a reference, and nothing out of anything else", () => {
    expect(assetSha(assetRef(SHA))).toBe(SHA);
    expect(assetSha(SHA)).toBeUndefined();
    expect(isSha256(SHA)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
  });

  it("should give plan each picture's address in place of its asset, keeping alt and decorative", () => {
    const planned = plan(plannable(outline(), (sha) => `/pictures/${sha}`));
    const images = planned.flatMap((one) => one.boxes.filter((box) => box.kind === "image"));
    expect(images.map((box) => box.kind === "image" && [box.src, box.alt, box.decorative])).toEqual([
      [`/pictures/${SHA}`, "The pipeline", false],
      [`/pictures/${OTHER}`, "", true],
      [`/pictures/${SHA}`, "The same pipeline", false]
    ]);
  });
});

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number, marker = 0xc0): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, a fill byte, then the frame header.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, marker, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0];
  return new Uint8Array([0xff, 0xd8, ...app0, 0xff, ...sof]);
}

describe("imageInfo", () => {
  it("should read a PNG's type and size from its header", () => {
    expect(imageInfo(png(640, 480))).toEqual({ mime: "image/png", width: 640, height: 480 });
  });

  it("should read a GIF's type and size from either version's header", () => {
    expect(imageInfo(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x00, 0x10, 0x00]))).toEqual({ mime: "image/gif", width: 32, height: 16 });
    expect(imageInfo(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00]))?.mime).toBe("image/gif");
  });

  it("should read a JPEG's size from its first frame header when segments come before it", () => {
    expect(imageInfo(jpeg(1024, 768))).toEqual({ mime: "image/jpeg", width: 1024, height: 768 });
    expect(imageInfo(jpeg(10, 20, 0xc2))).toEqual({ mime: "image/jpeg", width: 10, height: 20 });
  });

  it("should skip a segment in the start-of-frame range that carries no size", () => {
    const table = [0xff, 0xc4, 0x00, 0x04, 0, 0];
    const bytes = jpeg(5, 6);
    const withTable = new Uint8Array([...bytes.slice(0, 2), ...table, ...bytes.slice(2)]);
    expect(imageInfo(withTable)).toEqual({ mime: "image/jpeg", width: 5, height: 6 });
  });

  it("should refuse a JPEG whose segments do not lead to a frame header", () => {
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0x12, 0x34, 0, 0, 0]))).toBeUndefined();
    expect(imageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeUndefined();
  });

  it("should refuse a picture wider or taller than an INTEGER column and a JPEG or GIF header can say", () => {
    expect(imageInfo(png(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE))).toEqual({ mime: "image/png", width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE });
    expect(imageInfo(png(MAX_IMAGE_SIDE + 1, 10))).toBeUndefined();
    expect(imageInfo(png(10, 2 ** 31))).toBeUndefined();
    expect(imageInfo(png(2 ** 32 - 1, 2 ** 32 - 1))).toBeUndefined();
  });

  it("should refuse a picture of no size, and anything that is not one of the three types", () => {
    expect(imageInfo(png(0, 10))).toBeUndefined();
    expect(imageInfo(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeUndefined();
    expect(imageInfo(new Uint8Array(0))).toBeUndefined();
  });
});

describe("isPptx", () => {
  it("should take a zip's local file header as a .pptx and nothing else", () => {
    expect(isPptx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isPptx(new TextEncoder().encode("PK"))).toBe(false);
  });
});

describe("slideReference", () => {
  it("should name the deck, its version, the slide's id and its title when the slide has an id", () => {
    expect(slideReference({ title: "Ways of working", version: 7 }, 3, "Releases take three weeks", "s_ab12")).toBe(
      '[Slide 4 of "Ways of working" v7, id s_ab12: "Releases take three weeks"]'
    );
  });

  it("should leave the id out for the title slide, and quote a title holding quotes", () => {
    expect(slideReference({ title: 'The "plan"', version: 1 }, 0, "The plan", undefined)).toBe('[Slide 1 of "The \\"plan\\"" v1: "The plan"]');
  });
});
