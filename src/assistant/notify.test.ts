import { describe, expect, it } from "vitest";
import {
  checkNotifyData,
  checkNotifyPut,
  MAX_NOTIFY_BODY,
  MAX_NOTIFY_DATA_BYTES,
  MAX_NOTIFY_DATA_DEPTH,
  MAX_NOTIFY_PREVIEW_BYTES,
  NOTIFY_PRODUCT_IDS,
  type NotifySource,
  subjectFits,
  subjectRefusal
} from "./notify.ts";

const NUL = String.fromCharCode(0);

const source = (overrides: Partial<Record<keyof NotifySource, unknown>> = {}) => ({
  product: "pcs",
  template_id: "AB1F3D4A-0000-4000-8000-000000000002",
  service_id: "5c1f3d4a-0000-4000-8000-000000000001",
  type: "email",
  name: "Claim received",
  notify_version: 4,
  notify_subject: "Claim ((ref))",
  notify_body: "Dear ((name))",
  notify_preview: "<p>Dear ((name))</p>",
  ...overrides
});

const put = (overrides: Record<string, unknown> = {}) => ({
  subject: "Claim ((ref))",
  body: "Dear ((name))",
  data: {},
  base_version: 0,
  source: source(),
  ...overrides
});

function refusal(value: unknown): string {
  const checked = checkNotifyPut(value);
  if (checked.ok) {
    throw new Error("expected a refusal");
  }
  return checked.error;
}

describe("checkNotifyPut", () => {
  it("should take a first version with its source, lowercasing Notify's ids", () => {
    const checked = checkNotifyPut(put({ summary: "  Loaded  " }));

    expect(checked).toEqual({
      ok: true,
      value: {
        subject: "Claim ((ref))",
        body: "Dear ((name))",
        data: {},
        base_version: 0,
        summary: "Loaded",
        source: { ...source(), template_id: "ab1f3d4a-0000-4000-8000-000000000002" }
      }
    });
  });

  it("should take a load the person asked for from the panel's picker", () => {
    const checked = checkNotifyPut(put({ by: "user" }));

    expect(checked.ok && checked.value.by).toBe("user");
  });

  it("should take an edit with no source on a version there is", () => {
    const checked = checkNotifyPut({ subject: null, body: "Hi", data: { name: "Ada" }, base_version: 3, base_revision: 1 });

    expect(checked).toEqual({ ok: true, value: { subject: null, body: "Hi", data: { name: "Ada" }, base_version: 3, base_revision: 1 } });
  });

  it("should refuse a first version with no source to take one from", () => {
    expect(refusal(put({ source: undefined }))).toMatch(/source is needed for the first version/);
  });

  it.each([
    ["a product with no Notify key", { source: source({ product: "nope" }) }, /source\.product is not a product/],
    ["an id that is not a UUID", { source: source({ template_id: "x" }) }, /source\.template_id must be a UUID/],
    ["a type Notify has not", { source: source({ type: "fax" }) }, /source\.type/],
    ["a body over the cap", { body: "x".repeat(MAX_NOTIFY_BODY + 1) }, /^body /],
    ["a NUL in the body", { body: `a${NUL}b` }, /body must not contain a NUL/],
    ["a preview over the cap", { source: source({ notify_preview: "é".repeat(MAX_NOTIFY_PREVIEW_BYTES / 2 + 1) }) }, /source\.notify_preview must be at most/],
    ["a field it does not know", { extra: 1 }, /Unrecognized key/],
    ["a blank summary", { summary: " " }, /^summary /],
    ["a negative base", { base_version: -1 }, /^base_version /],
    ["an author other than the person", { by: "agent" }, /^by /]
  ])("should refuse %s, naming the field", (_label, change, message) => {
    expect(refusal(put(change))).toMatch(message);
  });

  it("should refuse a subject that does not fit the type", () => {
    expect(refusal(put({ subject: null }))).toBe("subject must be text for an email");
    expect(refusal(put({ subject: "Hi", source: source({ type: "sms", notify_subject: null }) }))).toBe("subject must be null for a text message");
    expect(refusal(put({ subject: null, source: source({ type: "sms" }) }))).toBe("source.notify_subject must be null for a text message");
  });

  it("should refuse data the hub cannot hold", () => {
    expect(refusal(put({ data: [] }))).toBe("data must be an object");
  });

  it("should word a body that is not an object at all", () => {
    expect(refusal(null)).toMatch(/^body /);
  });
});

describe("checkNotifyData", () => {
  it("should take an object of personalisation", () => {
    expect(checkNotifyData({ name: "Ada", items: ["a", "b"] })).toEqual({ ok: true, value: { name: "Ada", items: ["a", "b"] } });
  });

  it("should refuse anything but an object, deep nesting, unstorable text and too much", () => {
    expect(checkNotifyData(null)).toEqual({ ok: false, error: "data must be an object" });
    expect(checkNotifyData("x")).toEqual({ ok: false, error: "data must be an object" });
    let deep: unknown = "x";
    for (let at = 0; at <= MAX_NOTIFY_DATA_DEPTH; at += 1) {
      deep = { deep };
    }
    expect(checkNotifyData(deep)).toEqual({ ok: false, error: `data nests more than ${MAX_NOTIFY_DATA_DEPTH} levels` });
    expect(checkNotifyData({ name: `a${NUL}` })).toMatchObject({ ok: false, error: expect.stringMatching(/cannot store/) });
    expect(checkNotifyData({ name: "x".repeat(MAX_NOTIFY_DATA_BYTES) })).toEqual({ ok: false, error: `data is larger than ${MAX_NOTIFY_DATA_BYTES} bytes` });
  });
});

describe("subjectFits", () => {
  it("should hold a text message to no subject and the others to one", () => {
    expect(subjectFits("sms", null)).toBe(true);
    expect(subjectFits("sms", "")).toBe(false);
    expect(subjectFits("email", "")).toBe(true);
    expect(subjectFits("letter", null)).toBe(false);
    expect(subjectRefusal("letter")).toBe("subject must be text for a letter");
  });
});

describe("NOTIFY_PRODUCT_IDS", () => {
  it("should be the package's built-in products", () => {
    expect(NOTIFY_PRODUCT_IDS.has("pcs")).toBe(true);
    expect(NOTIFY_PRODUCT_IDS.has("sptribs")).toBe(true);
  });
});
