import { describe, expect, it } from "vitest";
import {
  checkDocmosisData,
  checkDocmosisPut,
  checkDocmosisSchema,
  docxRef,
  docxSha,
  isDocx,
  isPdf,
  MAX_DATA_BYTES,
  MAX_DATA_DEPTH,
  MAX_PROPERTIES,
  MAX_SCHEMA_DEPTH,
  storableError
} from "./docmosis.ts";

const SHA = "a".repeat(64);
const base = { controls: [], notes: [] };

const scalar = (kind = "string") => ({ kind, ...base });
const object = (properties: Record<string, unknown>) => ({ kind: "object", ...base, properties });
const schema = (properties: Record<string, unknown> = { name: scalar() }) => ({ root: object(properties), warnings: [] });

/** An object `levels` deep, the root being the first. */
function nested(levels: number): unknown {
  let inner: unknown = object({ leaf: scalar() });
  for (let level = levels - 1; level >= 1; level -= 1) {
    inner = object({ child: inner });
  }
  return { root: inner, warnings: [] };
}

function put(overrides: Record<string, unknown> = {}) {
  return { name: "Claim form", docx: docxRef(SHA), schema: schema(), data: { name: "Ada" }, base_version: 0, ...overrides };
}

function refused(value: unknown): string {
  const result = checkDocmosisPut(value);
  if (result.ok) {
    throw new Error("expected the body to be refused");
  }
  return result.error;
}

describe("checkDocmosisSchema", () => {
  it("should accept scalars, objects, arrays of objects and an inputFormat", () => {
    const value = schema({
      name: scalar(),
      when: { ...scalar("date"), inputFormat: "dd/MM/yyyy" },
      flag: { ...scalar("boolean"), controls: ["cs_isEngland"] },
      address: object({ line: scalar() }),
      parties: { kind: "array", ...base, item: object({ party: scalar() }) }
    });

    expect(checkDocmosisSchema(value)).toEqual({ ok: true, value });
  });

  it("should accept a schema nested exactly to the depth cap and refuse one level more", () => {
    expect(checkDocmosisSchema(nested(MAX_SCHEMA_DEPTH)).ok).toBe(true);

    const result = checkDocmosisSchema(nested(MAX_SCHEMA_DEPTH + 1));
    expect(result.ok).toBe(false);
  });

  it("should count an array's item as a level", () => {
    const array = (levels: number): unknown => {
      let inner: unknown = object({ leaf: scalar() });
      for (let level = levels - 1; level >= 1; level -= 1) {
        inner = object({ list: { kind: "array", ...base, item: inner } });
      }
      return { root: inner, warnings: [] };
    };

    expect(checkDocmosisSchema(array(MAX_SCHEMA_DEPTH)).ok).toBe(true);
    expect(checkDocmosisSchema(array(MAX_SCHEMA_DEPTH + 1)).ok).toBe(false);
  });

  it("should accept an object with the most properties and refuse one more", () => {
    const properties = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, at) => [`p${at}`, scalar()]));

    expect(checkDocmosisSchema(schema(properties(MAX_PROPERTIES))).ok).toBe(true);
    const over = checkDocmosisSchema(schema(properties(MAX_PROPERTIES + 1)));
    expect(over).toMatchObject({ ok: false, error: expect.stringContaining(`at most ${MAX_PROPERTIES} properties`) });
  });

  it("should refuse an unknown kind, an unknown key and a missing part, naming the path", () => {
    expect(checkDocmosisSchema(schema({ x: { kind: "number", ...base } }))).toMatchObject({ ok: false });
    expect(checkDocmosisSchema(schema({ x: { ...scalar(), extra: 1 } }))).toMatchObject({ ok: false });
    expect(checkDocmosisSchema({ root: object({}) })).toMatchObject({ ok: false, error: expect.stringContaining("schema.warnings") });
    expect(checkDocmosisSchema("nope")).toMatchObject({ ok: false });
  });

  it("should refuse a schema over the byte cap as stored", () => {
    const wide = schema({ name: { ...scalar(), notes: Array.from({ length: 200 }, () => "x".repeat(1500)) } });

    expect(checkDocmosisSchema(wide)).toMatchObject({ ok: false, error: expect.stringContaining("larger than 120000 bytes") });
  });

  it("should refuse a NUL in the schema's text", () => {
    expect(checkDocmosisSchema(schema({ name: { ...scalar(), notes: [`a${String.fromCharCode(0)}b`] } }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot store")
    });
  });
});

describe("checkDocmosisData", () => {
  it("should accept an object and refuse anything else", () => {
    expect(checkDocmosisData({ a: [1, { b: true }] })).toEqual({ ok: true, value: { a: [1, { b: true }] } });
    for (const value of [null, [], "text", 4]) {
      expect(checkDocmosisData(value)).toEqual({ ok: false, error: "data must be an object" });
    }
  });

  it("should refuse data nested past the cap without recursing into it", () => {
    let deep: unknown = {};
    for (let level = 0; level < MAX_DATA_DEPTH + 5; level += 1) {
      deep = { next: deep };
    }

    expect(checkDocmosisData(deep)).toMatchObject({ ok: false, error: expect.stringContaining("nests more than") });
  });

  it("should refuse data over the byte cap as Postgres prints it, which is longer than compact JSON", () => {
    // `", "` and `": "` add two bytes an item; the compact text is under the cap and the stored one is over.
    const items = Array.from({ length: 50_000 }, () => 1);
    const value = { a: items };
    expect(JSON.stringify(value).length).toBeLessThanOrEqual(MAX_DATA_BYTES);

    expect(checkDocmosisData(value)).toMatchObject({ ok: false, error: expect.stringContaining("larger than") });
  });

  it("should refuse half of a surrogate pair", () => {
    expect(checkDocmosisData({ a: "\ud800" })).toMatchObject({ ok: false, error: expect.stringContaining("cannot store") });
  });
});

describe("checkDocmosisPut", () => {
  it("should accept the body and trim its text", () => {
    const result = checkDocmosisPut(put({ name: "  Claim form ", summary: " Added a row ", base_revision: 2 }));

    expect(result).toEqual({
      ok: true,
      value: { name: "Claim form", docx: docxRef(SHA), schema: schema(), data: { name: "Ada" }, base_version: 0, base_revision: 2, summary: "Added a row" }
    });
  });

  it("should name the field it refuses", () => {
    expect(refused(put({ name: "" }))).toMatch(/^name /);
    expect(refused(put({ name: "x".repeat(201) }))).toMatch(/^name /);
    expect(refused(put({ docx: "sha256:abc" }))).toMatch(/^docx /);
    expect(refused(put({ docx: SHA }))).toMatch(/^docx /);
    expect(refused(put({ base_version: -1 }))).toMatch(/^base_version /);
    expect(refused(put({ base_version: 1.5 }))).toMatch(/^base_version /);
    expect(refused(put({ base_revision: "1" }))).toMatch(/^base_revision /);
    expect(refused(put({ summary: "" }))).toMatch(/^summary /);
    expect(refused(put({ summary: "x".repeat(201) }))).toMatch(/^summary /);
    expect(refused(put({ schema: { root: 1, warnings: [] } }))).toMatch(/^schema\.root /);
    expect(refused(put({ data: [] }))).toBe("data must be an object");
  });

  it("should refuse a name the database cannot hold", () => {
    expect(refused(put({ name: `a${String.fromCharCode(0)}` }))).toMatch(/^name /);
  });
});

describe("the byte checks", () => {
  it("should recognise a zip's signature as a .docx and %PDF- as a PDF", () => {
    expect(isDocx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe(true);
    expect(isDocx(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(isPdf(new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    expect(isPdf(new TextEncoder().encode("%PDF"))).toBe(false);
  });

  it("should read the digest out of a reference and refuse anything else", () => {
    expect(docxSha(docxRef(SHA))).toBe(SHA);
    expect(docxSha(SHA)).toBeUndefined();
    expect(docxSha(`sha256:${"A".repeat(64)}`)).toBeUndefined();
  });
});

describe("storableError", () => {
  it("should cut both texts and drop NULs", () => {
    const cut = storableError({ short: `a${String.fromCharCode(0)}${"b".repeat(600)}`, long: "c".repeat(9000) });

    expect(cut.short).toHaveLength(500);
    expect(cut.short.startsWith("ab")).toBe(true);
    expect(cut.long).toHaveLength(8000);
  });
});
