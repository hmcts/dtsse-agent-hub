import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page } from "@playwright/test";

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
 */
export async function registerAgent(request: APIRequestContext, persona: string, name: string): Promise<string | undefined> {
  const response = await request.post("/api/agent/register", {
    headers: { "x-dev-user": devUser(persona) },
    data: { session_id: unique(`e2e-${name}`), name, repo: "dtsse-agent-hub", branch: "e2e" }
  });
  if (response.status() === 401) {
    return undefined;
  }
  expect(response.status()).toBe(200);
  return ((await response.json()) as { agent_id: string }).agent_id;
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
