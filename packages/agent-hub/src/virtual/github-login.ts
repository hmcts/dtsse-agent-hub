// The pod's GitHub sign-in: device codes relayed to the owner, polled here, and the token granted stored on the hub
// and in gh.
import { type Api, createApi } from "../api.ts";
import type { Env } from "../env.ts";
import { type RetryOptions, sleep, withRetry } from "../retry.ts";
import { requireVirtualAgent } from "../virtual-agent.ts";
import { DeviceLoginError, type LoginOptions } from "./device-relay.ts";
import { type DeviceCode, deviceFlowRetryable, oauthAppLabel, pollDeviceToken, requestDeviceCode } from "./github-device-flow.ts";
import { say } from "./phases.ts";
import { childEnv, outputTail, run } from "./process.ts";

const GH_CLEAN = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"];

/**
 * How many codes one call offers the owner, whatever ended the one before. Each replaces the last on their
 * screen, so the bound is what keeps somebody from being handed a fresh code for as long as the pod runs; three
 * fifteen-minute codes is three quarters of an hour of asking, longer than anyone needs to walk to another
 * screen and shorter than a working day.
 *
 * It is not conditioned on why an attempt failed, because every reason deserves the next code: a code that ran
 * out unused means the owner was not there yet, and a poll GitHub answered with a fault, or a hub that could not
 * be told about the code, got no verdict out of them at all. Spending the budget on a fault that turns out to be
 * permanent costs three codes nobody uses; withholding it would turn one bad answer into a pod that stops
 * asking, which is the fault this bound exists to stop, only reached sooner.
 */
export const GITHUB_SIGN_IN_CODES = 3;

/**
 * How long to leave between codes. An attempt that failed on the poll is over in seconds, so without a wait the
 * budget is three codes in half a minute — the same fault three times, and none of the second chance at a fault
 * that may not last which is why the budget is not conditioned on the reason. A minute is what GitHub's
 * secondary rate limits are usually measured in, and it is nothing beside an attempt that ran its code out.
 */
export const GITHUB_SIGN_IN_GAP_MS = 60_000;

/**
 * The longest gap `setTimeout` can keep: past a signed 32-bit millisecond count it fires after 1ms instead, so a
 * number beyond this would remove the gap rather than lengthen it.
 */
const MAX_GAP_MS = 2 ** 31 - 1;

/**
 * The gap `AGENT_HUB_GITHUB_SIGN_IN_GAP_MS` asks for, or the default. A pod being watched through a sign-in is
 * the reason this is settable at all: three codes a minute apart is three minutes before anyone sees the end.
 *
 * Anything that is not a whole number of milliseconds in range gives the default rather than being argued with,
 * and that has to include the empty string: `Number("")` is 0, so a Helm value that rendered to nothing, or an
 * `env` entry with `value: ""`, would otherwise read as a deliberate request for no gap at all — the one setting
 * that brings back what the gap exists to stop, asked for by a variable nobody set.
 */
export function githubSignInGapMs(env: Env = process.env): number {
  // Digits and nothing else: `Number` would otherwise read `1e4` as ten thousand and `0x10` as sixteen, so a
  // typo in a hex-looking value would quietly become a sixteen-millisecond gap.
  const raw = (env.AGENT_HUB_GITHUB_SIGN_IN_GAP_MS ?? "").trim();
  if (!/^\d+$/.test(raw)) {
    return GITHUB_SIGN_IN_GAP_MS;
  }
  const asked = Number(raw);
  return asked <= MAX_GAP_MS ? asked : GITHUB_SIGN_IN_GAP_MS;
}

export type GithubLoginOptions = LoginOptions & {
  /** How many codes are offered and the wait between them; only a test moves these. How long each one lasts is GitHub's to say. */
  codes?: number;
  gapMs?: number;
  /** How the wait between codes is taken, as `withRetry` takes its own: a test passes one that does not wait. */
  wait?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
};

export type GithubLoginResult = "signed-in" | "not-signed-in";

/**
 * What the owner is told when none of their codes was completed. The three cases are the three things that can
 * have happened to the last one: it ran out while they were away, something stopped the pod finishing it, or
 * GitHub ended it. Each says what to do next, because this is the agent's `status_detail` and the only thing
 * they see — the pod's log carries what `gh` said, which is for whoever is reading logs.
 */
function githubNotSignedInDetail(expired: boolean, broke: boolean): string {
  if (expired) {
    return "github: the sign-in code ran out before it was used; start the agent again to be sent another";
  }
  return broke
    ? "github: the sign-in could not be finished; start the agent again to be sent another code"
    : "github: GitHub stopped the sign-in before it could be completed, so the code is no longer any use";
}

/**
 * What the owner is told when the sign-in worked and keeping what it granted did not. Which of the two stores
 * failed is the whole of what decides whether there is anything for them to do: a token gh is holding is one
 * the pod puts right by itself, and one GitHub will not take needs a current one from them.
 */
function githubStoreFailedDetail(hubFailed: boolean, ghFailed: boolean): string {
  if (!ghFailed) {
    return "github: signed in, but the token could not be saved to agent-hub yet; this agent is holding it and will keep trying";
  }
  return hubFailed
    ? "github: signed in, but the token could not be saved either on agent-hub or in this agent"
    : "github: GitHub would not accept the token the sign-in granted; it is saved on agent-hub, so this agent will keep trying it";
}

/**
 * Runs one of the two stores and answers the error it ended with, or `null`. Each is run this way rather than
 * allowed to throw, because neither failing may end the call before the other has been tried.
 *
 * Whatever it rejected with becomes an `Error` with something to say, so that `null` is the only thing that
 * means "stored". A store rejecting with something falsy would otherwise read as success to a truthiness check
 * and as failure to a `!== null` one, and the two live a few lines apart: the token would be nowhere and the
 * call would answer `signed-in`. Wording the value in rather than passing it through is what keeps the pod's
 * log from carrying "github: undefined" as the whole account of why a sign-in did not stick.
 */
const storeAttempt = async (store: () => Promise<unknown>, options: RetryOptions): Promise<Error | null> =>
  withRetry(store, options).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(`the store rejected with ${String(e)}`))
  );

/**
 * The token gh holds, or `""` for none. Tolerates a `gh auth token` that fails, because having no sign-in yet is
 * one of the ways it does: only safe where no sign-in has been run, which is the reuse check below.
 */
const storedGhToken = async (env: NodeJS.ProcessEnv): Promise<string> =>
  (await run("gh", ["auth", "token", "--hostname", "github.com"], { env })).stdout.trim();

/**
 * What the agent's status says while a code is live. Its own length with nothing in it is what
 * `RELAY_WORDING_CHARS` measures and what `MAX_URI_CHARS` is derived from, so this wording and that constant
 * have to move together: `github-login.test.ts` asserts the one against the other, because a derived figure nothing
 * holds to the thing it measures goes stale the first time somebody rewords this line.
 */
export const githubLoginStatus = (userCode: string, verificationUri: string): string => `github: the owner must enter code ${userCode} at ${verificationUri}`;

/**
 * Puts a code on the owner's screen. Throws a `DeviceLoginError` whose `shown` says whether the hub ever had
 * it: a `loginPrompt` that landed and a `virtualStatus` that did not still leaves a live code in front of
 * them, and only a code they could have used is one the hub is owed a `failed` for.
 */
async function relayGithubCode({
  api,
  id,
  code,
  wait
}: {
  api: Pick<Api, "loginPrompt" | "virtualStatus">;
  id: string;
  code: DeviceCode;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  let shown = false;
  try {
    await withRetry(
      async () => {
        await api.loginPrompt(id, "github", {
          prompt: "device_code",
          verification_uri: code.verification_uri,
          user_code: code.user_code,
          expires_in: code.expires_in
        });
        shown = true;
        await api.virtualStatus(id, "awaiting_login", githubLoginStatus(code.user_code, code.verification_uri));
      },
      { wait }
    );
  } catch (e) {
    throw new DeviceLoginError(`could not relay the github sign-in code: ${(e as Error).message}`, shown);
  }
}

/** How many times gh is asked to store a token the owner has already granted. */
export const GH_STORE_ATTEMPTS = 3;

/**
 * Relays GitHub device codes to the owner and stores the token the sign-in grants, up to `codes` of them,
 * `gapMs` apart. Returns 'not-signed-in' once they are spent, having told the hub so, which is the one outcome
 * its caller must not retry: the owner has been asked as often as this will ask, and only they can act.
 *
 * A failure the owner was never asked about throws instead, so that a caller rides it out — a hub that could not
 * be reached before the code got there, or a GitHub that would not mint one. Reporting one of those as the other
 * is what leaves somebody told they did not sign in when nothing ever reached their screen.
 *
 * The flow itself is polled here rather than by `gh auth login --web`, because gh ends a sign-in on the first
 * poll answer that is neither `authorization_pending` nor a single `slow_down` — see `github-device-flow.ts`.
 * That is why the budget and the poll are different bounds and both are wanted: this one bounds how long a
 * single code is held open, and the budget bounds how many codes an owner is ever handed.
 *
 * gh still stores the token, through `--with-token`, which validates it against the API as it writes it: a
 * token GitHub will not accept fails here rather than at the clone, and the pod's git credentials come from
 * where they always did.
 */
export async function githubLogin({
  api = createApi(),
  env = process.env,
  codes = GITHUB_SIGN_IN_CODES,
  gapMs = githubSignInGapMs(env),
  wait = sleep,
  fetchImpl
}: GithubLoginOptions = {}): Promise<GithubLoginResult> {
  const { id } = requireVirtualAgent(env);
  const ghEnv = childEnv(env, GH_CLEAN);
  say(`github: signing in through ${oauthAppLabel(env)}`);
  // An earlier call in this pod may have been granted a token and failed only to finish storing it. gh's config
  // is a memory-backed emptyDir, so a token here is one this pod was granted, and relaying another code for it
  // would ask the owner to authorise what they have authorised already.
  let token = await storedGhToken(ghEnv);
  // Whether any code reached the owner's screen, which is what makes the outcome theirs to act on rather than a
  // fault to ride out, and what the hub is owed a `failed` for.
  let shown = false;
  let expired = false;
  // Whether what ended the last attempt was this pod's side of it rather than GitHub's answer about the code.
  let broke = false;
  // What the pod's log is told, which is not what the owner is told: this one names the fault.
  let said = "";
  let thrown: unknown;
  if (token) {
    say("github: gh is already signed in; storing the token it holds");
  } else {
    for (let attempt = 1; attempt <= codes; attempt++) {
      // What is left of the gap once this attempt is over, so the wait fills the time the attempt did not: an
      // attempt that ran its code out has already waited a quarter of an hour, and one that failed on the first
      // poll has waited seconds.
      const startedAt = Date.now();
      const gapLeft = () => Math.max(0, gapMs - (Date.now() - startedAt));
      try {
        const code = await withRetry(() => requestDeviceCode({ env, fetchImpl }), { retryable: deviceFlowRetryable, wait });
        await relayGithubCode({ api, id, code, wait });
        shown = true;
        // Only the last attempt's failure words what the hub is told, so an earlier one goes once this gets a
        // code in front of the owner: it is no longer what happened.
        thrown = undefined;
        say("github: sign-in code relayed to the owner through agent-hub");
        const polled = await pollDeviceToken({ code, env, fetchImpl, wait, onWait: (detail) => say(`github: ${detail}`) });
        if (polled.outcome === "token") {
          token = polled.token;
          break;
        }
        expired = polled.outcome === "expired";
        // A refusal with no OAuth word is no poll having reached GitHub at all, which is this pod's side of it.
        broke = polled.outcome === "refused" && polled.error === "";
        said = polled.outcome === "refused" ? polled.detail : "the code reached its expires_in unused";
      } catch (e) {
        // Caught per attempt rather than around the loop, because a code the owner never answered and a relay
        // that could not be completed are the same thing to the budget: one code gone, and the next one earned.
        thrown = e;
        expired = false;
        broke = true;
        said = (e as Error).message;
        // A relay that failed after the hub had the code still put one on the owner's screen.
        if (e instanceof DeviceLoginError && e.shown) {
          shown = true;
        }
      }
      if (attempt < codes) {
        say(`github: ${said}; relaying a fresh code in ${Math.round(gapLeft() / 1000)}s, which replaces it`);
        await wait(gapLeft());
      }
    }
  }

  if (token) {
    const granted = token;
    // Two stores, attempted independently rather than as one step, because only losing **both** loses a grant
    // the owner has already given. The hub holds the copy that outlives the pod — gh's config is a
    // memory-backed emptyDir — and gh's is what lets this pod clone and what validates the token as it is
    // written. Either one left holding it is a way on that costs the owner nothing further, so neither
    // failing may end the call before the other has been tried.
    //
    // The hub goes first: that is the fault this order exists for. gh's store reaches api.github.com to
    // validate, and a token lost to a blip there is one the owner has to authorise again.
    const hubFailed = await storeAttempt(() => api.putCredential(id, "github", granted), { wait });
    const ghFailed = await storeAttempt(
      async () => {
        const r = await run("gh", ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token"], {
          env: ghEnv,
          input: `${granted}\n`
        });
        if (r.code !== 0) {
          // gh's own words, redacted: what GitHub answered is the difference between a scope the app no longer
          // grants and a token already revoked. Retried, because a fault reaching the API reads exactly like a
          // refusal from it and three tries cost seconds.
          throw new Error(`gh would not store the GitHub token the owner signed in for (exit ${r.code}): ${outputTail(r.stderr)}`);
        }
      },
      { attempts: GH_STORE_ATTEMPTS, wait }
    );
    if (hubFailed === null && ghFailed === null) {
      // The owner's part is done and both stores have it, so a hub that will not mark the row throws rather
      // than being reported as a sign-in that failed: reporting one would withdraw the code they used. It is
      // safe to throw past the report for the same reason the hub-failed row below is — the token is in gh's
      // config, so the caller's next attempt finds it through `storedGhToken` and completes the row without
      // relaying anything — and the pending row it leaves meanwhile is bounded by the `awaiting_owner` sweep.
      const login = (await run("gh", ["api", "user", "--jq", ".login"], { env: ghEnv })).stdout.trim();
      await withRetry(() => api.loginComplete(id, "github", login ? { account_label: login } : {}), { wait });
      say(login ? `github: signed in as ${login}` : "github: signed in");
      return "signed-in";
    }
    // Whichever failed says so in full in the pod's log; the hub gets the wording the owner can act on.
    for (const failure of [hubFailed, ghFailed]) {
      if (failure !== null) {
        say(`github: ${failure.message}`);
      }
    }
    const unstored = (hubFailed ?? ghFailed) as Error;
    if (!shown) {
      // Nobody was asked for this token — it came out of gh's own config — so there is nothing to conclude
      // about the owner and nothing for the hub to mark. The caller rides it out, and no code is spent.
      throw unstored;
    }
    const detail = githubStoreFailedDetail(hubFailed !== null, ghFailed !== null);
    // Reported before either way out, because the owner was shown a code and the hub is owed exactly one
    // outcome for it. Leaving the row pending holds a dead code on their screen until the sweep, and the next
    // call completes it from `failed` as readily as from `pending`.
    await reportGithubFailure({ api, id, state: "failed", detail, wait });
    say(detail);
    if (hubFailed !== null && ghFailed === null) {
      // gh is holding the grant, so this is the one failure the next call repairs for free: `storedGhToken`
      // finds the token, the loop is skipped, and the hub is tried again with no code spent. A throw is what
      // gets that next call — `not-signed-in` would stop the asking and leave the boot script watching for a
      // stored token that is the very thing that could not be stored.
      throw hubFailed;
    }
    // The hub has the token and gh would not take it, or neither has it. Both are the owner's to act on: the
    // first is what the boot script's watcher retries without a new code, the second needs one from them.
    return "not-signed-in";
  }

  if (shown) {
    const detail = githubNotSignedInDetail(expired, broke);
    await reportGithubFailure({ api, id, state: expired ? "expired" : "failed", detail, wait });
    say(`${detail} (${said})`);
    // The owner has had every code this offers, so asking again is not what is wanted even though an attempt
    // threw: a caller that retried would relay a fresh code on each pass, for as long as the pod ran.
    return "not-signed-in";
  }
  // Nobody was asked, so there is nothing to report and nothing about the owner to conclude. The message carries
  // whatever failed, and `runVirtual` logs it for the pod on the way out.
  throw thrown ?? new Error("github: the sign-in relayed no code and gave no reason");
}

/**
 * The hub is owed one of `complete` or `failed` for every sign-in shown to an owner, who is otherwise left
 * holding a code that no longer works and an agent that reads as waiting for them. Few attempts, and never
 * fatal: the caller is about to be told the sign-in failed either way.
 *
 * Every `detail` that reaches here is one of the fixed wordings above, which is what keeps it inside the hub's
 * 500 characters: the hub rejects a longer one rather than truncating it, and a `400` is not retryable, so a
 * fault's own message interpolated into one would be a report that never arrives. The message goes to `say`.
 */
async function reportGithubFailure({
  api,
  id,
  state,
  detail,
  wait
}: {
  api: Pick<Api, "loginFailed">;
  id: string;
  state: "expired" | "failed";
  detail: string;
  wait?: (ms: number) => Promise<void>;
}): Promise<void> {
  await withRetry(() => api.loginFailed(id, "github", { state, detail }), { attempts: 3, wait }).catch((e: unknown) => {
    say(`github: could not tell agent-hub the sign-in was not completed (${(e as Error).message})`);
  });
}
