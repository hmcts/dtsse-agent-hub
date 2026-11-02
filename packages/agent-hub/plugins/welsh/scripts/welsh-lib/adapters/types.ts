/**
 * The contract every storage-format adapter implements. An adapter knows how
 * one format pairs English with Welsh; it knows nothing about catalogues.
 */

export interface Adapter {
  name: string;
  /** Every English leaf and the state of its Welsh counterpart. */
  extract(repo: string, files: string[], options: AdapterOptions): Leaf[];
  /** Write Welsh values at the locations `extract` reported. Returns files changed. */
  write(repo: string, edits: Edit[]): string[];
}

export interface AdapterOptions {
  /** Layout hints from config.yaml, adapter-specific. */
  [key: string]: unknown;
}

/** One English string and where its Welsh lives (or should live). */
export interface Leaf {
  adapter: string;
  /** English file, repo-relative. */
  enFile: string;
  /** Welsh file, repo-relative — may not exist yet. */
  cyFile: string;
  /** Path inside the file, dotted for display; `path` is the exact form. */
  key: string;
  path: (string | number)[];
  english: string;
  /** Current Welsh, or null when the key (or the whole file) is missing. */
  welsh: string | null;
  /** The Welsh file itself does not exist yet. */
  cyMissing?: boolean;
  /** Interpolation syntax in this format, for token checks. */
  tokens: TokenSyntax;
  line?: number;
  /** Set when the value can be read but not safely rewritten (spreads, calls…). */
  readOnly?: string;
}

export type TokenSyntax = "js-template" | "i18next" | "brace" | "none";

export interface Edit {
  leaf: Leaf;
  welsh: string;
}
