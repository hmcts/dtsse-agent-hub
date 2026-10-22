// The topics a turn could be filed under, found mechanically so the model does not have to find them itself.
import { jiraKey, slugify, TOPIC_RE, type WorkspacePlace, workspacePlace, workspaceRepoName } from "../agent.ts";
import { projectDir } from "../session.ts";
import { NO_TOUCHES, type Touches } from "./touches.ts";

// Upper-case prefixes that look like Jira keys but are standards and algorithms.
const NOT_JIRA = new Set(["AES", "CVE", "HTTP", "ISO", "RFC", "SHA", "SSL", "TLS", "UTF"]);
const JIRA_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
const HMCTS_REF_RE = /(?:github\.com\/|(?<![\w./-]))hmcts\/([A-Za-z0-9][\w.-]*)(?:\/(issues|pull)\/(\d+)|#(\d+))?/g;
const NOT_REPOS = new Set(["apps", "libs", "platops", "docs", "scripts"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function workspacePathRe(root: string): RegExp {
  return new RegExp(`(?:${escapeRegExp(root)}/|(?<![\\w./~-])(?:\\./)?)(apps/[A-Za-z0-9][\\w.-]*(?:/[\\w.-]+)?|(?:libs|platops)/[\\w.-]+)`, "g");
}

function jiraKeys(text: string | null | undefined): string[] {
  return [...(text || "").matchAll(JIRA_RE)].map((m) => m[0]).filter((key) => !NOT_JIRA.has(key.split("-")[0] as string));
}

type CandidateKind = "repos" | "products" | "tickets";

export type CandidateTopics = {
  repos: string[];
  products: string[];
  tickets: string[];
  workedIn: {
    repos: string[];
    products: string[];
  };
};

export type CandidateTopicsOptions = {
  text?: string;
  touches?: Touches;
  cwd?: string | null;
  repo?: string | null;
  branch?: string | null;
  root?: string;
  workspaceRepo?: string | null;
};

// Topic candidates the session's tool calls, its registration and the transcript point at, so the
// model does not have to find them itself: repos and products it touched (worked in first, then only
// read), then those from its registered clone, workspace paths and hmcts/<repo> references in what was
// said; tickets from Jira keys and GitHub issue/PR references. The workspace repo is a candidate only
// when its own files were touched. Every candidate is a valid slug.
export function candidateTopics({
  text = "",
  touches = NO_TOUCHES,
  cwd = null,
  repo = null,
  branch = null,
  root = projectDir(),
  workspaceRepo = workspaceRepoName(root)
}: CandidateTopicsOptions = {}): CandidateTopics {
  const found: CandidateTopics = { repos: [], products: [], tickets: [], workedIn: { repos: [], products: [] } };
  const seen = new Set<string>();
  const add = (kind: CandidateKind, raw: unknown): boolean => {
    const slug = typeof raw === "string" ? raw.toLowerCase() : null;
    if (!slug || !TOPIC_RE.test(slug) || seen.has(slug)) {
      return false;
    }
    seen.add(slug);
    found[kind].push(slug);
    return true;
  };
  const addMentioned = (kind: CandidateKind, raw: string | null): void => {
    if (kind === "repos" && raw && raw === workspaceRepo) {
      return;
    }
    add(kind, raw);
  };
  const addPlace = (place: WorkspacePlace | null): void => {
    if (!place) {
      return;
    }
    addMentioned("repos", place.repo);
    addMentioned("products", place.product);
  };

  for (const kind of ["repos", "products"] as const) {
    const list = touches[kind] || [];
    for (const t of [...list.filter((e) => e.workedIn), ...list.filter((e) => !e.workedIn)]) {
      if (add(kind, t.slug) && t.workedIn) {
        found.workedIn[kind].push(t.slug);
      }
    }
  }
  addMentioned("repos", repo ? slugify(repo) : null);
  const cwdPlace = workspacePlace(cwd, root);
  if (cwdPlace?.repo) {
    addPlace(cwdPlace);
  }
  for (const m of text.matchAll(workspacePathRe(root))) {
    addPlace(workspacePlace(m[1], root));
  }
  const refs = [...text.matchAll(HMCTS_REF_RE)].map((m) => {
    const name = slugify((m[1] as string).replace(/\.git$/i, ""));
    return { name: name && !NOT_REPOS.has(name) ? name : null, kind: m[2], number: m[3] || m[4] };
  });
  for (const ref of refs) {
    addMentioned("repos", ref.name);
  }

  for (const key of [...jiraKeys(branch), ...jiraKeys(text)]) {
    add("tickets", key);
  }
  const branchKey = jiraKey(branch);
  if (branchKey && !NOT_JIRA.has((branchKey.split("-")[0] as string).toUpperCase())) {
    add("tickets", branchKey);
  }
  for (const ref of refs) {
    if (ref.name && ref.number) {
      add("tickets", `${ref.name}-${ref.kind === "issues" ? "issue" : "pr"}-${ref.number}`);
    }
  }
  return found;
}
