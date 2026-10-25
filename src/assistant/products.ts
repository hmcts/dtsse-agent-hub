/**
 * The product areas a person can pick for a conversation. The slug is stored on the conversation and sent to its
 * session with every message, so the session knows which part of the workspace the person means.
 */

export interface Product {
  slug: string;
  label: string;
}

/**
 * General is first and the catch-all; the rest are the `apps/` products of the CFT workspace in alphabetical order by
 * label. Every slug but `general` and `platform` is the name of a workspace product directory.
 */
export const PRODUCTS: readonly Product[] = [
  { slug: "general", label: "General" },
  { slug: "am", label: "Access Management (AM)" },
  { slug: "adoption", label: "Adoption" },
  { slug: "bulk-scan", label: "Bulk Scan" },
  { slug: "cath", label: "CaTH (Court and Tribunal Hearings)" },
  { slug: "ccd", label: "CCD (Core Case Data)" },
  { slug: "civil", label: "Civil" },
  { slug: "cmc", label: "CMC (Civil Money Claims)" },
  { slug: "cuiys", label: "CUI Your Support" },
  { slug: "dm", label: "Document Management (DM)" },
  { slug: "dtsse", label: "DTSSE" },
  { slug: "et", label: "Employment Tribunals (ET)" },
  { slug: "em", label: "Evidence Management (EM)" },
  { slug: "fact", label: "FACT (Find a Court or Tribunal)" },
  { slug: "fpl", label: "Family Public Law (FPL)" },
  { slug: "finrem", label: "Financial Remedy (Finrem)" },
  { slug: "fis", label: "FIS (Family Integration Service)" },
  { slug: "hmc", label: "HMC (Hearings Management Component)" },
  { slug: "idam", label: "IDAM" },
  { slug: "ia", label: "Immigration & Asylum (IA)" },
  { slug: "nfdiv", label: "No Fault Divorce (NFDIV)" },
  { slug: "payment", label: "Payment (Fees & Pay)" },
  { slug: "platform", label: "Platform" },
  { slug: "pcs", label: "Possession Claims Service (PCS)" },
  { slug: "prl", label: "Private Family Law (PRL)" },
  { slug: "probate", label: "Probate" },
  { slug: "pt", label: "Property Tribunal (PT)" },
  { slug: "rd", label: "Reference Data (RD)" },
  { slug: "send-letter", label: "Send Letter (Bulk Print)" },
  { slug: "sptribs", label: "Special Tribunals" },
  { slug: "sscs", label: "SSCS (Social Security and Child Support)" },
  { slug: "wa", label: "Work Allocation (WA)" },
  { slug: "xui", label: "XUI (Expert UI)" }
];

export const DEFAULT_PRODUCT = "general";

export function isProduct(slug: unknown): slug is string {
  return typeof slug === "string" && PRODUCTS.some((product) => product.slug === slug);
}

/** The display name of a stored slug; a slug no longer offered shows as itself rather than failing. */
export function productLabel(slug: string): string {
  return PRODUCTS.find((product) => product.slug === slug)?.label ?? slug;
}

/**
 * The offered product a conversation's stored slug stands for: one that is not offered stands for the default. A
 * slug can be stored and then stop being offered — a product retired from the list, or one written by a replica
 * still on the previous bundle during a rolling deploy — and the picker can only show what it offers, so every
 * reader of the current product uses this to agree with it. `product_history` is not coerced: it records what was
 * picked at the time.
 */
export function storedProduct(slug: string): string {
  return isProduct(slug) ? slug : DEFAULT_PRODUCT;
}
