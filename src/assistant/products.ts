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
  { slug: "civil", label: "Civil" },
  { slug: "cmc", label: "Civil Money Claims (CMC)" },
  { slug: "ccd", label: "Core Case Data (CCD)" },
  { slug: "cath", label: "Court and Tribunal Hearings (CaTH)" },
  { slug: "cuiys", label: "CUI Your Support" },
  { slug: "dm", label: "Document Management (DM)" },
  { slug: "dtsse", label: "DTS Software Engineering (DTSSE)" },
  { slug: "et", label: "Employment Tribunals (ET)" },
  { slug: "em", label: "Evidence Management (EM)" },
  { slug: "xui", label: "Expert UI (XUI)" },
  { slug: "fis", label: "Family Integration Service (FIS)" },
  { slug: "fpl", label: "Family Public Law (FPL)" },
  { slug: "finrem", label: "Financial Remedy (Finrem)" },
  { slug: "fact", label: "Find a Court or Tribunal (FACT)" },
  { slug: "hmc", label: "Hearings Management Component (HMC)" },
  { slug: "idam", label: "Identity and Access Management (IDAM)" },
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
  { slug: "sscs", label: "Social Security and Child Support (SSCS)" },
  { slug: "sptribs", label: "Special Tribunals" },
  { slug: "wa", label: "Work Allocation (WA)" }
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
 * still on the previous bundle during a rolling deploy — and the picker can only show what it offers, so what the
 * hub renders goes through this. What a session is told does not: its frame and wake carry the stored slug, so a
 * conversation keeps the subject it was started in, as does `product_history`, which records what was picked.
 */
export function storedProduct(slug: string): string {
  return isProduct(slug) ? slug : DEFAULT_PRODUCT;
}
