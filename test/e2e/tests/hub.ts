import { type APIRequestContext, type Browser, type BrowserContext, expect, type Locator, type Page } from "@playwright/test";

/**
 * What the specs share. They run against a deployment with `AUTH_DISABLED=true`, where the viewer is a development
 * persona chosen by the `ah_dev_persona` cookie, so two browser contexts can be two people.
 */

export const PERSONA_COOKIE = "ah_dev_persona";

/** Short and unique per run, so specs never collide with each other or with a previous run's data. */
export function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
}

export async function asPersona(browser: Browser, persona: string, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: PERSONA_COOKIE, value: persona, url: baseURL }]);
  return context;
}

/** The persona's identity as the service derives it, for the agent API's development header. */
export function devUser(persona: string): string {
  return `dev-${persona}|Dev ${persona} (sign-in disabled)|${persona}@dev.invalid`;
}

/**
 * Registers an agent owned by `persona` through the agent API, or returns `undefined` where the deployment checks
 * real Entra tokens (agent authentication stays on in preview and AAT), so a spec needing one can skip.
 *
 * The registration names no virtual agent and no conversation, which is what the hub reads as a session on somebody's
 * own computer: it is given an assistant conversation of its own, titled `name`. See Conversations in
 * `docs/agent-api.md`.
 *
 * `clientFeatures` is what the client running the session claims it understands, for a spec about a control the UI
 * only offers to a session that claimed the field behind it. Left out, the agent claims nothing, as a client from
 * before client features existed reports nothing.
 */
export async function registerAgent(request: APIRequestContext, persona: string, name: string, clientFeatures?: string[]): Promise<string | undefined> {
  const response = await request.post("/api/agent/register", {
    headers: { "x-dev-user": devUser(persona) },
    data: {
      session_id: unique(`e2e-${name}`),
      name,
      repo: "dtsse-agent-hub",
      branch: "e2e",
      ...(clientFeatures === undefined ? {} : { client_features: clientFeatures })
    }
  });
  if (response.status() === 401) {
    return undefined;
  }
  expect(response.status()).toBe(200);
  return ((await response.json()) as { agent_id: string }).agent_id;
}

/**
 * Puts an agent `registerAgent` made into a status, as its own client would: `busy` and `idle` are a heartbeat, and
 * `offline` is the call the client makes as the session ends. One helper for the three, because a spec asks the same
 * question of all of them — what the UI shows while the session is in that state.
 */
export async function setAgentStatus(request: APIRequestContext, persona: string, agentId: string, status: "busy" | "idle" | "offline"): Promise<void> {
  const headers = { "x-dev-user": devUser(persona) };
  const response =
    status === "offline"
      ? await request.post(`/api/agent/${agentId}/offline`, { headers })
      : await request.post(`/api/agent/${agentId}/heartbeat`, { headers, data: { status } });
  expect(response.status()).toBe(204);
}

/**
 * One connection of an agent's own stream, whole: the `: connected` comment, every delivery still queued for that
 * agent, and the `reconnect` event the server ends on.
 *
 * It answers only once the server has ended the stream, which it does at `STREAM_MAX_SECONDS` — 25 seconds by
 * default. A Playwright API request reads a response to its end rather than as it arrives, so there is no way to
 * close it from here on the first frame; a spec calling this raises its own timeout to suit.
 */
export async function readAgentStream(request: APIRequestContext, persona: string, agentId: string): Promise<string> {
  const response = await request.get(`/api/agent/${agentId}/stream`, {
    headers: { "x-dev-user": devUser(persona), accept: "text/event-stream" },
    timeout: 90_000
  });
  expect(response.status()).toBe(200);
  return await response.text();
}

/**
 * Stores placeholder GitHub and Claude credentials for `persona` through the agent API, so the Assistant's
 * chat is past the gate that holds it at GitHub and Claude. Nothing in a spec runs a pod to use them. A deployment
 * that keeps no credentials (503), or none for a development identity (403), leaves the gate open anyway, and one
 * that checks real agent tokens (401) cannot be driven this way, so none of them is an error here.
 */
export async function connectForChat(request: APIRequestContext, persona: string): Promise<void> {
  const values = { github: `ghp_${"e2e".repeat(10)}`, claude: `sk-ant-oat-${"e2e".repeat(10)}` };
  for (const [kind, value] of Object.entries(values)) {
    const response = await request.put(`/api/agent/credentials/${kind}`, { headers: { "x-dev-user": devUser(persona) }, data: { value } });
    expect([204, 401, 403, 503]).toContain(response.status());
  }
}

/**
 * A unique persona on the own-licence model route, which is the route whose chat gate `connectForChat` can satisfy.
 *
 * A development persona is on the AI Gateway route unless it is named `own-licence` or `own-licence-…`
 * (`devModelRoute` in `src/viewer/identity.ts`), and that route's gate is on the person's Azure sign-in — a device
 * code their pod relays, which no spec can stand in for. So a spec that needs the Assistant to render a chat rather
 * than the screen asking for accounts names its person through this.
 */
export function chatPersona(what: string): string {
  return unique(`own-licence-${what}`);
}

/**
 * Sends the Assistant's getting-ready surface away, so what is behind it can be used.
 *
 * Someone whose assistant is not running waits on a full-screen `aria-modal` surface over their chats, and nothing a
 * spec can do starts one — no pod runs here. Escape is what sends it away, and the screen remembers the choice in a
 * cookie, so one press clears it for the rest of that context's visit, navigations included.
 *
 * Only a surface that can be sent away: the screen holding someone at GitHub and their model credential refuses
 * Escape, which is why this asserts that nothing modal is left rather than pressing and carrying on. The way past
 * that one is `chatPersona` with `connectForChat`.
 *
 * The press is retried because the surface is in the first HTML and its key handler is not: a press before the
 * browser has taken the page over reaches nothing.
 */
export async function dismissGettingReady(page: Page): Promise<void> {
  const surface = page.getByRole("dialog");
  await expect(async () => {
    if ((await surface.count()) === 0) {
      return;
    }
    await page.keyboard.press("Escape");
    await expect(surface).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

export interface TranscriptEntry {
  key: string;
  role: "user" | "assistant" | "tool_use" | "tool_result" | "system";
  content: Record<string, unknown>;
  truncated?: boolean;
  redacted?: boolean;
  message_id?: string | null;
  occurred_at: string;
}

/** Uploads transcript entries for an agent `registerAgent` made, and returns how many were new. */
export async function uploadTranscript(request: APIRequestContext, persona: string, agentId: string, entries: TranscriptEntry[]): Promise<number> {
  const response = await request.post(`/api/agent/${agentId}/transcript`, {
    headers: { "x-dev-user": devUser(persona) },
    data: { session_id: unique("e2e-session"), entries }
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { accepted: number }).accepted;
}

/**
 * Puts a question on screen for an agent `registerAgent` made, as the client's `PreToolUse` hook does for
 * `AskUserQuestion`. `multiSelect` decides whether the card offers checkboxes and a submit or radios that send at once.
 */
export async function askQuestion(
  request: APIRequestContext,
  persona: string,
  agentId: string,
  question: { question: string; header: string; options: { label: string; description: string }[]; multiSelect?: boolean }
): Promise<void> {
  const response = await request.post(`/api/agent/${agentId}/question`, {
    headers: { "x-dev-user": devUser(persona) },
    data: {
      session_id: unique("e2e-session"),
      tool_use_id: unique("toolu"),
      questions: [{ multiSelect: false, ...question }]
    }
  });
  expect(response.status()).toBe(204);
}

/** A small conversation with every kind of entry the page renders, keyed under `prefix`. */
export function sampleTranscript(prefix: string): TranscriptEntry[] {
  const at = (seconds: number) => new Date(Date.now() - 60_000 + seconds * 1000).toISOString();
  return [
    { key: `${prefix}:1`, role: "user", content: { text: "Please run the unit tests" }, occurred_at: at(0) },
    { key: `${prefix}:2`, role: "tool_use", content: { id: "t1", name: "Bash", input: { command: "yarn test" } }, occurred_at: at(1) },
    { key: `${prefix}:3`, role: "tool_result", content: { tool_use_id: "t1", output: "1 failed\n".repeat(3), is_error: true }, occurred_at: at(2) },
    { key: `${prefix}:4`, role: "tool_use", redacted: true, content: { id: "t2", name: "Read", redacted: "AKIA[0-9A-Z]{16}" }, occurred_at: at(3) },
    { key: `${prefix}:5`, role: "assistant", content: { text: "One test **failed**; fixing it now." }, truncated: true, occurred_at: at(4) }
  ];
}

/**
 * The sidebar row of a local session registered as `title`, found by its accessible name — the local marker's words
 * joined to the title (`LocalMark`) — so every spec using it also fails on a chat the sidebar has stopped marking.
 *
 * The state of the session is part of those words and is matched loosely, because it is whatever the session was
 * doing when the page rendered; that the row is marked, and marked as being on the person's own computer, is what
 * this pins. `unique` titles are alphanumeric and so need no escaping here.
 */
export function localChatRow(page: Page, title: string): Locator {
  return page.getByRole("navigation", { name: "Chats" }).getByRole("link", { name: new RegExp(`^On your computer, [a-z ]+: ${title}$`) });
}

/**
 * Opens the chat of a local session registered as `title` from the Assistant's sidebar, and returns its path.
 *
 * The sidebar is where a spec learns the conversation's id: the registration answers with the agent alone, and
 * nothing names the conversation the hub made for it. `page` is already showing a page of the Assistant, so the
 * caller keeps the response its own skip reads.
 */
export async function openLocalChat(page: Page, title: string): Promise<string> {
  const row = localChatRow(page, title);
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForURL(/\/assistant\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Builds a channel through the builder and returns its URL. */
export async function buildChannel(page: Page, name: string, topics: string[]): Promise<string> {
  await page.goto("/hub/channels/new");
  const search = page.getByLabel(/^Topics/);
  for (const topic of topics) {
    await search.fill(topic);
    await page.getByRole("button", { name: "Add topic" }).click();
    await expect(page.getByRole("button", { name: `Remove ${topic}` })).toBeVisible();
  }
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Save channel" }).click();
  await page.waitForURL(/\/hub\/channels\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}
