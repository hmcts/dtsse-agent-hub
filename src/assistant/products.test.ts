import { describe, expect, it } from "vitest";
import { DEFAULT_PRODUCT, isProduct, PRODUCTS, productLabel } from "./products.ts";

describe("products", () => {
  it("should offer the prototype's products, with Other the default", () => {
    expect(PRODUCTS.map((product) => product.label)).toEqual(["CaTH Service", "CCD", "No Fault Divorce", "Probate", "Civil Possessions", "Other"]);
    expect(isProduct(DEFAULT_PRODUCT)).toBe(true);
  });

  it("should fit every slug in the database's product check", () => {
    for (const product of PRODUCTS) {
      expect(product.slug).toMatch(/^[a-z0-9-]{1,32}$/);
    }
  });

  it.each([["ccd"], ["nfdiv"]])("should accept %s when it is offered", (slug) => {
    expect(isProduct(slug)).toBe(true);
  });

  it.each([["CCD"], ["unknown"], [""], [42], [null]])("should refuse %j when it is not an offered slug", (slug) => {
    expect(isProduct(slug)).toBe(false);
  });

  it("should label a slug no longer offered as itself", () => {
    expect(productLabel("pcs")).toBe("Civil Possessions");
    expect(productLabel("retired")).toBe("retired");
  });
});
