// A virtual agent's pod, faked: a throwaway HOME with fake az, gh, twg and script(1) on PATH that print what
// the real ones print and keep just enough state to rotate a token. No real sign-in is ever started.
//
// Every secret-shaped value is built at runtime, as `claude-home.ts` does: this tree is published to npm.
import fs from "node:fs";
import path from "node:path";
import { type TempClaudeHome, tempClaudeHome } from "./claude-home.ts";

export const podSecrets = {
  launchToken: `launch-${"x".repeat(16)}`,
  githubToken: `${"gh"}o_${"Q7w8E9r0".repeat(4)}`,
  claudeToken: `${"sk-ant"}-oat01-${"Zy3_".repeat(20)}`,
  azureRefresh: `refresh-${"R".repeat(40)}`,
  twgAccess: `${"twg"}-access-${"A".repeat(3000)}`,
  twgRefresh: `${"twg"}-refresh-${"T".repeat(40)}`
};

export const TWG_CODE = "EA32-3702";
export const TWG_URL = `https://auth.atlassian.com/oauth/activate?user_code=${TWG_CODE}`;

// The sign-in link `claude setup-token` prints. Its opaque parameters are synthetic, as everything above is.
export const AUTHORIZE_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code" +
  "&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference" +
  `&code_challenge=${"A1b2C3d4".repeat(5)}&code_challenge_method=S256&state=${"Zy3_".repeat(8)}`;

export const AZ_OUTPUT = "To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code LNKR6UHMN to authenticate.\n";
export const GH_OUTPUT = "\n! First copy your one-time code: 7B7F-C198\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
export const CLAUDE_OUTPUT =
  `\x1b[?25l\x1b[1mWelcome to Claude Code v2.1.287\x1b[22m\r\n Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\n` +
  `\x1b]8;id=1om6vol;${AUTHORIZE_URL}\x1b\\${AUTHORIZE_URL}\x1b]8;;\x1b\\\r\n\r\n Paste code here if prompted > `;

// What `twg login --site hmcts` 1.3.3 draws on a pty, with a colour reset between the URL's characters.
export const TWG_LOGIN_OUTPUT =
  `\r\n\x1b[1m\x1b[38;5;253m  TWG Login (OAuth)\x1b[39m\x1b[22m\r\n\x1b[38;5;253m  ${"─".repeat(17)}\x1b[39m\r\n\r\n` +
  `\x1b[38;5;253m  🔐 OAuth Device Authentication\x1b[39m\r\n\r\n` +
  `  Visit: \x1b[38;5;74m${[...TWG_URL].join("\x1b[39m")}\x1b[39m\r\n  Code:  \x1b[38;5;74m${TWG_CODE}\x1b[39m\r\n` +
  `  ⚠️  Only approve this request if you initiated it from your terminal.\r\n` +
  `\x1b[?25l\x1b[90m│\x1b[39m\r\n\x1b[36m◆\x1b[39m  Open in browser?\r\n` +
  `\x1b[36m│\x1b[39m  \x1b[32m●\x1b[39m Y \x1b[2m/\x1b[22m \x1b[2m○\x1b[22m \x1b[2mn\x1b[22m\r\n\x1b[36m└\x1b[39m\r\n\x1b[1A\r\n`;
export const TWG_WAIT_OUTPUT = `\x1b[35m◒\x1b[39m    Waiting for authentication in browser... (120s remaining)\x1b[1G\x1b[J`;

/**
 * How `twg login` 1.3.3 gives up when nobody uses its code: its own timer, which is two minutes whenever twg reads
 * the environment as an agent's. The bracketed error code is what tells this apart from any other failure.
 */
export const TWG_LOGIN_TIMEOUT_OUTPUT =
  `\r\n\x1b[31m✖\x1b[39m  OAuth authentication failed: Login timed out after 2 minutes: browser authentication was not ` +
  `completed. This looks like a non-interactive/agent environment — run \`twg login\` yourself in an interactive ` +
  `terminal to finish authenticating.\r\n  Code:        [login_timeout]\r\n`;

/** A sign-in that broke rather than ran out: the owner said no. Shaped as above, with a different code. */
export const TWG_LOGIN_DENIED_OUTPUT = `\r\n\x1b[31m✖\x1b[39m  OAuth authentication failed: The user denied the request.\r\n  Code:        [access_denied]\r\n`;

export type MsalCacheOptions = {
  refresh?: string;
  accessTokens?: number;
  padding?: number;
};

/** An MSAL token cache shaped like the one `az login` writes, with `accessTokens` large access tokens. */
export function msalCache({ refresh = podSecrets.azureRefresh, accessTokens = 3, padding = 0 }: MsalCacheOptions = {}): Record<string, unknown> {
  const account = {
    home_account_id: "oid-owner.tid",
    environment: "login.microsoftonline.com",
    realm: "531ff96d-0ae9-462a-8d2d-bec7c0b42082",
    username: "olive@hmcts.net",
    authority_type: "MSSTS"
  };
  const AccessToken: Record<string, unknown> = {};
  for (let i = 0; i < accessTokens; i++) {
    AccessToken[`at-${i}`] = { secret: `at-secret-${i}-${"a".repeat(1500)}`, target: `scope-${i}` };
  }
  return {
    AccessToken,
    Account: { "oid-owner.tid-login.microsoftonline.com-tid": account },
    IdToken: { "id-1": { secret: `id-${"i".repeat(padding)}` } },
    RefreshToken: { "rt-1": { secret: refresh, credential_type: "RefreshToken" } },
    AppMetadata: { "app-1": { client_id: "04b07795" } }
  };
}

export type TwgAuthConfOptions = {
  refresh?: string;
  access?: string;
  user?: string;
};

/** twg's auth.conf as 1.3.3 writes it. */
export function twgAuthConf({ refresh = podSecrets.twgRefresh, access = podSecrets.twgAccess, user = "olive@hmcts.net" }: TwgAuthConfOptions = {}): string {
  return [
    "# TWG CLI credentials",
    "# Generated by: twg login",
    "#",
    "",
    `user=${user}`,
    "token=oauth-managed",
    "site=hmcts",
    "domain=hmcts.atlassian.net",
    "auth-method=oauth",
    `oauth-access-token=${access}`,
    `oauth-refresh-token=${refresh}`,
    "oauth-refresh-at=2099-01-01T00:00:00.000Z",
    ""
  ].join("\n");
}

export type PodShims = {
  home: TempClaudeHome;
  bin: string;
  stateDir: string;
  /** The pod's environment: fake commands on PATH, the throwaway HOME, and the agent's id and launch token. */
  env: (extra?: Record<string, string>) => Record<string, string>;
  shim: (name: string, body: string) => void;
  /** Reinstalls the script(1) shim a test replaced. */
  scriptShim: () => void;
  /** The sign-in a pod would have after `twg login`, as the fake twg accepts it. */
  seedTwg: (env: Record<string, string>, refresh?: string) => void;
  /** Forgets everything one test wrote: the sign-ins on disk, the shims' counters and the pod's state dir. */
  reset: () => void;
  cleanup: () => void;
};

export type CreatePodShimsOptions = {
  virtualId: string;
  hubUrl: string;
  ownerOid?: string;
};

export function createPodShims({ virtualId, hubUrl, ownerOid = "oid-owner" }: CreatePodShimsOptions): PodShims {
  const home = tempClaudeHome();
  const bin = path.join(home.root, "bin");
  const stateDir = path.join(home.root, "shim-state");
  fs.mkdirSync(bin);
  fs.mkdirSync(stateDir);

  const shim = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  };

  // Stands in for script(1): the claude setup-token TUI on a pty, or the command it was given.
  const scriptShim = () => {
    shim(
      "script",
      `case "$4" in *"twg login"*) exec bash -c "$4" ;; esac
cat "$SHIM_STATE/claude.out"
IFS= read -r -d $'\\r' code
[ "$code" = "good-code#state" ] || { echo "OAuth error: invalid code"; exit 1; }
printf '\\r\\n ✓ Long-lived authentication token created successfully!\\r\\n\\r\\n Your OAuth token (valid for 1 year):\\r\\n\\r\\n \\x1b[1m%s\\x1b[22m\\r\\n\\r\\n Store this token securely.\\r\\n' "$FAKE_CLAUDE_TOKEN"
sleep 30`
    );
  };

  fs.writeFileSync(path.join(stateDir, "cache.json"), JSON.stringify(msalCache()));
  fs.writeFileSync(path.join(stateDir, "az.out"), AZ_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "gh.out"), GH_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "claude.out"), CLAUDE_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "twg-login.out"), TWG_LOGIN_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "twg-wait.out"), TWG_WAIT_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "twg-timeout.out"), TWG_LOGIN_TIMEOUT_OUTPUT);
  fs.writeFileSync(path.join(stateDir, "twg-denied.out"), TWG_LOGIN_DENIED_OUTPUT);

  shim(
    "az",
    `case "$1 $2" in
  "account get-access-token") [ -f "$SHIM_STATE/az-ok" ] && exit 0; echo "ERROR: AADSTS700082: The refresh token has expired" >&2; exit 1 ;;
  "login --use-device-code") cat "$SHIM_STATE/az.out" >&2; sleep 0.3; mkdir -p "$AZURE_CONFIG_DIR"
      cp "$SHIM_STATE/cache.json" "$AZURE_CONFIG_DIR/msal_token_cache.json"; touch "$SHIM_STATE/az-ok"; echo "[]" ;;
  "ad signed-in-user") printf '{"id": "%s", "upn": "olive@hmcts.net", "mail": null, "name": "Olive Owner"}\\n' "$SHIM_OID" ;;
  *) echo "unexpected az $*" >&2; exit 2 ;;
esac`
  );
  // The two shapes a GitHub sign-in fails in, each giving the words gh prints: `FAKE_GH_LOGIN_FAILS` after the
  // code, which is a sign-in that broke under the owner, and `FAKE_GH_LOGIN_CRASHES` instead of one, which
  // leaves them nothing to enter. Both exit 1 with no token, and what gh said is their only record.
  shim(
    "gh",
    `case "$1 $2" in
  "auth login") [ -n "$GH_TOKEN$GITHUB_TOKEN" ] && exit 9; [ "$BROWSER" = true ] || exit 8; printf '%s\\n' "$*" > "$SHIM_STATE/gh-login-args"
      [ -n "$FAKE_GH_LOGIN_CRASHES" ] && { printf '%s\\n' "$FAKE_GH_LOGIN_CRASHES" >&2; exit 1; }
      cat "$SHIM_STATE/gh.out" >&2; sleep 0.3
      [ -n "$FAKE_GH_LOGIN_FAILS" ] && { printf '%s\\n' "$FAKE_GH_LOGIN_FAILS" >&2; exit 1; }
      printf '%s' "$FAKE_GH_TOKEN" > "$SHIM_STATE/gh-token"; echo "✓ Authentication complete." >&2 ;;
  "auth token") cat "$SHIM_STATE/gh-token" 2>/dev/null || exit 1 ;;
  "api user") [ -n "$FAKE_GH_USER" ] && { printf '%s\\n' "$FAKE_GH_USER"; exit 0; }; echo octocat ;;
  "api user/emails") [ -n "$FAKE_GH_EMAILS" ] && { printf '%s\\n' "$FAKE_GH_EMAILS"; exit 0; }; echo '{"message":"Not Found"}'; exit 1 ;;
  *) exit 2 ;;
esac`
  );
  scriptShim();
  // Stands in for twg 1.3.3: each refresh rotates both tokens, and only the newest refresh token works.
  // `FAKE_TWG_LOGIN`: `expire` gives up on the code as twg's own timer does, after `FAKE_TWG_EXPIRE_AFTER` seconds;
  // `deny` fails for another reason after printing a code; `crash` fails before printing one.
  shim(
    "twg",
    `auth="$TWG_CONFIG_DIR/auth.conf"
current() { sed -n 's/^oauth-refresh-token=//p' "$auth" 2>/dev/null; }
valid() { [ -n "$(current)" ] && [ "$(current)" = "$(cat "$SHIM_STATE/twg-valid" 2>/dev/null)" ]; }
rotate() {
  n=$(($(cat "$SHIM_STATE/twg-n" 2>/dev/null || echo 0) + 1)); echo "$n" >"$SHIM_STATE/twg-n"
  mkdir -p "$TWG_CONFIG_DIR"
  printf '# TWG CLI credentials\\n# Updated: %s\\n#\\n\\nuser=%s\\ntoken=oauth-managed\\nsite=hmcts\\ndomain=hmcts.atlassian.net\\nauth-method=oauth\\noauth-access-token=%s-%s\\noauth-refresh-token=%s-%s\\noauth-refresh-at=2099-01-01T00:00:00.000Z\\n' \\
    "$n" "\${FAKE_TWG_USER:-olive@hmcts.net}" "$TWG_ACCESS" "$n" "$TWG_REFRESH" "$n" >"$auth"
  cp "$auth" "$TWG_CONFIG_DIR/auth_oauth.conf"
  printf '%s-%s' "$TWG_REFRESH" "$n" >"$SHIM_STATE/twg-valid"
}
echo "$*" >>"$SHIM_STATE/twg.log"
case "$1 $2" in
  "auth refresh") [ -n "$FAKE_TWG_REFRESH_WIPES" ] && { rm -f "$auth"; echo "Error: could not write the credentials file." >&2; exit 1; }
      valid || { echo "Error: Authentication failed." >&2; exit 77; }
      { [ "$3" = --force ] || [ -f "$SHIM_STATE/twg-due" ]; } && rotate; exit 0 ;;
  "doctor -o") if [ -z "$FAKE_TWG_DOCTOR_FAILS" ] && valid && grep -q '^oauth-access-token=' "$auth"; then ok=true; else ok=false; fi
      printf '{"apiVersion":"v2","data":{"connectivity":{"attempted":true,"ok":%s}}}\\n' "$ok"; [ "$ok" = true ] ;;
  "login --site") [ "$FAKE_TWG_LOGIN" = crash ] && { echo "twg: internal error" >&2; exit 70; }
      cat "$SHIM_STATE/twg-login.out"
      IFS= read -r -d $'\\r' answer
      [ "$answer" = n ] || { echo "opened a browser"; exit 5; }
      for i in 1 2 3; do cat "$SHIM_STATE/twg-wait.out"; sleep 0.1; done
      [ "$FAKE_TWG_LOGIN" = expire ] && { sleep "\${FAKE_TWG_EXPIRE_AFTER:-0}"; cat "$SHIM_STATE/twg-timeout.out"; exit 1; }
      [ "$FAKE_TWG_LOGIN" = deny ] && { cat "$SHIM_STATE/twg-denied.out"; exit 1; }
      rotate; printf '\\r\\n\\x1b[32m✓\\x1b[39m  Authentication successful!\\r\\n' ;;
  *) echo "unexpected twg $*" >&2; exit 2 ;;
esac`
  );

  const env = (extra: Record<string, string> = {}): Record<string, string> => ({
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home.root,
    CLAUDE_CONFIG_DIR: home.claude,
    AZURE_CONFIG_DIR: path.join(home.root, ".azure"),
    AGENT_HUB_URL: hubUrl,
    AGENT_HUB_VIRTUAL_AGENT_ID: virtualId,
    AGENT_HUB_LAUNCH_TOKEN: podSecrets.launchToken,
    AZURE_TENANT_ID: "531ff96d-0ae9-462a-8d2d-bec7c0b42082",
    TWG_CONFIG_DIR: path.join(home.root, ".twg"),
    TWG_ACCESS: podSecrets.twgAccess,
    TWG_REFRESH: podSecrets.twgRefresh,
    SHIM_STATE: stateDir,
    SHIM_OID: ownerOid,
    ...extra
  });

  const seedTwg = (podEnv: Record<string, string>, refresh = `${podSecrets.twgRefresh}-0`) => {
    fs.mkdirSync(podEnv.TWG_CONFIG_DIR as string, { recursive: true });
    fs.writeFileSync(path.join(podEnv.TWG_CONFIG_DIR as string, "auth.conf"), twgAuthConf({ refresh }));
    fs.writeFileSync(path.join(stateDir, "twg-valid"), refresh);
  };

  const reset = () => {
    fs.rmSync(path.join(home.root, ".azure"), { recursive: true, force: true });
    fs.rmSync(path.join(home.root, ".twg"), { recursive: true, force: true });
    for (const f of ["az-ok", "gh-token", "twg-valid", "twg-n", "twg-due", "twg.log"]) {
      fs.rmSync(path.join(stateDir, f), { force: true });
    }
    fs.rmSync(path.join(home.hub, "virtual"), { recursive: true, force: true });
  };

  return { home, bin, stateDir, env, shim, scriptShim, seedTwg, reset, cleanup: home.cleanup };
}

/** Points `hubHome()` at the fake pod's HOME for the whole file, and gives back the restore. */
export function usePodEnv(home: TempClaudeHome): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(home.env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/** Everything the client writes to stderr while `fn` runs. */
export async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), stderr: out };
  } finally {
    process.stderr.write = write;
  }
}

/** The stderr of a call that is expected to throw, with the error it threw. */
export async function captureStderrOfFailure(fn: () => Promise<unknown>): Promise<{ error: unknown; stderr: string }> {
  const write = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
    return { error: null, stderr: out };
  } catch (e) {
    return { error: e, stderr: out };
  } finally {
    process.stderr.write = write;
  }
}
