// A virtual agent's git identity. ~/.gitconfig is not on the pod's persistent volume, so the
// entrypoint sets it on every boot and before every Claude restart.
import type { Api } from "./api.ts";
import { withRetry } from "./retry.ts";

export const GIT_DEFAULTS: [string, string][] = [
  ["push.autoSetupRemote", "true"],
  ["init.defaultBranch", "master"]
];

export type ExecResult = {
  code: number;
  stdout: string;
};

/** Runs a command and resolves to its exit code and standard output. */
export type Exec = (cmd: string, args: string[]) => Promise<ExecResult>;

export type Identity = {
  name: string | null;
  email: string | null;
};

export type Override = Partial<Identity>;

export type ChosenIdentity = Identity & {
  nameWhy: string | null;
  emailWhy: string | null;
};

export type GitHubUser = {
  login?: unknown;
  id?: unknown;
  name?: unknown;
  email?: unknown;
};

export type GitHubEmail = {
  email?: unknown;
  verified?: unknown;
};

export type ChooseIdentityOptions = {
  override?: Override;
  overrideWhy?: string;
  user?: GitHubUser | null;
  emails?: GitHubEmail[] | null;
  hmcts?: string | null;
  displayName?: string | null;
  existing?: Override;
};

export type SetGitIdentityOptions = {
  api: Pick<Api, "getCredential">;
  id: string;
  exec: Exec;
  log: (message: string) => void;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const same = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// The commands here all print JSON on success; anything else — a non-zero exit, a usage message, a truncated
// body — counts as "could not be reached" rather than throwing out of a boot step.
function json(r: ExecResult): unknown {
  if (r.code !== 0) {
    return null;
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The owner's stored override, `{"name"?, "email"?}`; anything else counts as none. */
export function parseOverride(value: string | null | undefined): Override {
  if (!value) {
    return {};
  }
  try {
    const o = asRecord(JSON.parse(value));
    if (!o) {
      return {};
    }
    return { name: text(o.name), email: text(o.email) };
  } catch {
    return {};
  }
}

/**
 * Picks user.name and user.email, and says why. GitHub links a commit to the account only through
 * an address on that account, so the HMCTS email is used only when GitHub knows it, and otherwise
 * the account's noreply address, which always links.
 */
export function chooseIdentity({
  override = {},
  overrideWhy = "stored on agent-hub",
  user = null,
  emails = null,
  hmcts = null,
  displayName = null,
  existing = {}
}: ChooseIdentityOptions): ChosenIdentity {
  let name: string | null = null;
  let nameWhy: string | null = null;
  if (override.name) {
    [name, nameWhy] = [override.name, overrideWhy];
  } else if (text(user?.name)) {
    [name, nameWhy] = [text(user?.name), "GitHub profile name"];
  } else if (text(user?.login)) {
    [name, nameWhy] = [text(user?.login), "GitHub login; the profile has no name"];
  } else if (existing.name) {
    [name, nameWhy] = [existing.name, "kept; GitHub could not be reached"];
  } else if (displayName) {
    [name, nameWhy] = [displayName, "Azure display name; GitHub could not be reached"];
  }

  let email: string | null = null;
  let emailWhy: string | null = null;
  const login = text(user?.login);
  if (override.email) {
    [email, emailWhy] = [override.email, overrideWhy];
  } else if (!login || !user?.id) {
    if (existing.email) {
      [email, emailWhy] = [existing.email, "kept; GitHub could not be reached"];
    } else if (hmcts) {
      [email, emailWhy] = [hmcts, "HMCTS email; GitHub could not be reached to check it"];
    }
  } else if (hmcts && emails?.some((e) => e?.verified && same(typeof e.email === "string" ? e.email : null, hmcts))) {
    [email, emailWhy] = [hmcts, "HMCTS email, verified on the GitHub account"];
  } else if (hmcts && same(typeof user.email === "string" ? user.email : null, hmcts)) {
    [email, emailWhy] = [hmcts, "HMCTS email, the GitHub account's public email"];
  } else {
    email = `${user.id}+${login}@users.noreply.github.com`;
    if (!hmcts) {
      emailWhy = "GitHub noreply address; az gave no HMCTS email";
    } else if (emails) {
      emailWhy = `GitHub noreply address; ${hmcts} is not a verified email on the GitHub account`;
    } else {
      emailWhy = `GitHub noreply address; ${hmcts} is not the public email, and the GitHub token cannot list emails (no user:email scope)`;
    }
  }
  return { name, nameWhy, email, emailWhy };
}

/**
 * Reads the override from the hub and the owner from gh and az, then sets the global git config.
 * `exec(cmd, args)` resolves to `{ code, stdout }`. Returns what it chose.
 */
export async function setGitIdentity({ api, id, exec, log }: SetGitIdentityOptions): Promise<ChosenIdentity> {
  const git = (...args: string[]) => exec("git", ["config", "--global", ...args]);
  const get = async (key: string) => text((await git("--get", key)).stdout);
  const existing: Override = { name: await get("user.name"), email: await get("user.email") };

  let source: { override: Override; overrideWhy?: string } = { override: {} };
  try {
    source.override = parseOverride(await withRetry(() => api.getCredential(id, "git_identity"), { attempts: 3 }));
  } catch (e) {
    log(`git: could not read the git_identity credential (${(e as Error).message})`);
    // An override that cannot be read must not be replaced by the defaults, so what is set stays.
    source = { override: existing, overrideWhy: "kept; agent-hub could not be read" };
  }

  const user = asRecord(json(await exec("gh", ["api", "user"])));
  const emails = user ? json(await exec("gh", ["api", "user/emails"])) : null;
  const az = asRecord(json(await exec("az", ["ad", "signed-in-user", "show", "--query", "{mail:mail,upn:userPrincipalName,name:displayName}", "-o", "json"])));
  const chosen = chooseIdentity({
    ...source,
    user,
    emails: Array.isArray(emails) ? (emails.map(asRecord).filter(Boolean) as GitHubEmail[]) : null,
    hmcts: text(az?.mail) || text(az?.upn),
    displayName: text(az?.name),
    existing
  });

  const settings: [string, string | null][] = [["user.name", chosen.name], ["user.email", chosen.email], ...GIT_DEFAULTS];
  const failed: string[] = [];
  for (const [key, value] of settings) {
    if (value && (await git(key, value)).code !== 0) {
      failed.push(key);
    }
  }
  log(chosen.name ? `git: user.name ${chosen.name} (${chosen.nameWhy})` : "git: no user.name could be found; leaving it unset");
  log(chosen.email ? `git: user.email ${chosen.email} (${chosen.emailWhy})` : "git: no user.email could be found; leaving it unset");
  if (failed.length) {
    throw new Error(`git config --global failed for ${failed.join(", ")}`);
  }
  return chosen;
}
