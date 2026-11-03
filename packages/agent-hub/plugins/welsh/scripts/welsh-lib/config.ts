/** welsh/config.yaml in a service's home repo (see home.ts) — which repos to scan and how. */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { homeRepo, welshDir } from "./home.ts";

export function loadConfig(service: string): ServiceConfig {
  const path = join(welshDir(service), "config.yaml");
  if (!existsSync(path)) {
    return { repos: [], identical_allowlist: [], placeholder_patterns: [], context_sensitive: [] };
  }
  const raw = (YAML.parse(readFileSync(path, "utf8")) ?? {}) as Partial<ServiceConfig>;
  return {
    // `.` is the home repo itself, so its own welsh/config.yaml need not know where the workspace keeps it.
    repos: (raw.repos ?? []).map((repo) => (repo.path === "." ? { ...repo, path: homeRepo(service) ?? repo.path } : repo)),
    identical_allowlist: raw.identical_allowlist ?? [],
    placeholder_patterns: raw.placeholder_patterns ?? [],
    context_sensitive: raw.context_sensitive ?? []
  };
}

export interface RepoConfig {
  /** Workspace-relative path to the clone, or `.` for the home repo the config is in. */
  path: string;
  /** Adapters to run; default is every adapter that understands files it finds. */
  adapters?: string[];
  include?: string[];
  exclude?: string[];
  /**
   * Pages only HMCTS staff see (admin and system-admin screens behind a staff role). Welsh is a duty to the public,
   * so these need none, and a scan skips them as it does `exclude`; kept apart so the reason is on record.
   */
  staff_only?: string[];
  /** Adapter options, e.g. `combined: [app/common/locale/content.json]` for json-pair. */
  options?: Record<string, unknown>;
  /** Command that must pass after `apply`, run in the clone. */
  test?: string;
}

export interface ServiceConfig {
  repos: RepoConfig[];
  identical_allowlist: string[];
  placeholder_patterns: string[];
  /** English that the catalogue may never fill on its own — added to the built-in Yes/No. */
  context_sensitive: string[];
}
