import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT, isProduct, PRODUCTS, productLabel } from "./products.ts";

function byCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

describe("products", () => {
  it("should offer General first, as the default, with the rest alphabetical", () => {
    expect(PRODUCTS[0]).toEqual({ slug: "general", label: "General" });
    expect(DEFAULT_PRODUCT).toBe("general");
    expect(isProduct(DEFAULT_PRODUCT)).toBe(true);

    const rest = PRODUCTS.slice(1).map((product) => product.label.toLowerCase());
    expect(rest).toEqual([...rest].sort(byCodePoint));
  });

  it("should offer each slug once", () => {
    const slugs = PRODUCTS.map((product) => product.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("should fit every slug in the database's product check", () => {
    for (const product of PRODUCTS) {
      expect(product.slug).toMatch(/^[a-z0-9-]{1,32}$/);
    }
  });

  it.each([["ccd"], ["nfdiv"], ["send-letter"]])("should accept %s when it is offered", (slug) => {
    expect(isProduct(slug)).toBe(true);
  });

  it.each([["CCD"], ["other"], ["unknown"], [""], [42], [null]])("should refuse %j when it is not an offered slug", (slug) => {
    expect(isProduct(slug)).toBe(false);
  });

  it("should label a slug no longer offered as itself", () => {
    expect(productLabel("other")).toBe("other");
    expect(productLabel("retired")).toBe("retired");
  });

  it("should label an offered slug with its display name", () => {
    expect(productLabel("pcs")).toBe("Possession Claims Service (PCS)");
  });
});
