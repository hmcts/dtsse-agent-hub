/**
 * The product areas a person can pick for a conversation. The slug is stored on the conversation and sent to its
 * session with every message, so the session knows which part of the workspace the person means.
 */

export interface Product {
  slug: string;
  label: string;
}

export const PRODUCTS: readonly Product[] = [
  { slug: "cath", label: "CaTH Service" },
  { slug: "ccd", label: "CCD" },
  { slug: "nfdiv", label: "No Fault Divorce" },
  { slug: "probate", label: "Probate" },
  { slug: "pcs", label: "Civil Possessions" },
  { slug: "other", label: "Other" }
];

export const DEFAULT_PRODUCT = "other";

export function isProduct(slug: unknown): slug is string {
  return typeof slug === "string" && PRODUCTS.some((product) => product.slug === slug);
}

/** The display name of a stored slug; a slug no longer offered shows as itself rather than failing. */
export function productLabel(slug: string): string {
  return PRODUCTS.find((product) => product.slug === slug)?.label ?? slug;
}
