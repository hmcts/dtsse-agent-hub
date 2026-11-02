import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import * as registerRoute from "../../src/app/api/agent/register/route.ts";
import * as claimRoute from "../../src/app/api/orchestrator/claim/route.ts";
import * as observedRoute from "../../src/app/api/orchestrator/virtual-agents/[id]/observed/route.ts";
import * as portsRoute from "../../src/app/api/virtual/[virtualAgentId]/ports/route.ts";
import * as statusRoute from "../../src/app/api/virtual/[virtualAgentId]/status/route.ts";
import { credentialBackend } from "../../src/credentials/backend.ts";
import type { SecretStore } from "../../src/credentials/store.ts";
import {
  type ClaimedVirtualAgent,
  type ClaimResult,
  claimVirtualAgents,
  createVirtualAgent,
  findVirtualAgent,
  type VirtualAgentRow
} from "../../src/virtual-agents/store.ts";
import { insertUser, type Person, person, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";

export const SECRET = "a-test-session-secret-long-enough-to-be-plausible";

/** The development personas the UI acts as, so the server actions and the agent API agree on who is who. */
export const ALICE: Person = { oid: "dev-alice", name: "Dev alice (sign-in disabled)", email: "alice@dev.invalid" };
export const BOB: Person = { oid: "dev-bob", name: "Dev bob (sign-in disabled)", email: "bob@dev.invalid" };
export const CAROL = person("carol");

export const GITHUB = `ghp_${"A1b2".repeat(9)}`;
export const CLAUDE = `sk-ant-oat01-${"Qw_-".repeat(12)}`;
export const JENKINS = `11${"a4f9c2e7b1".repeat(3)}`;
export const TENANT = "531ff96d-0ae9-462a-8d2d-bec7c0b42082";

const AZURE_CLI = "04b07795-8ddb-461a-bbee-02f9e1bf7b46";
const LOGIN = "login.microsoftonline.com";

export type AzureCacheOptions = {
  /** One account per realm: `az login --tenant` writes the one, `az login` alone also `organizations` and every tenant it lists. */
  realms?: string[];
  /** A B2B guest's names them in their home tenant. */
  home?: string;
  /** The `home_account_id` of each refresh token, `undefined` for one with none. */
  refreshTokens?: (string | undefined)[];
};

/** A cache as the pod uploads it: `az login`'s MSAL cache without its access tokens. */
export function azureCacheFor(oid: string, { realms = [TENANT], home = `${oid}.${TENANT}`, refreshTokens = [home] }: AzureCacheOptions = {}): string {
  const Account = Object.fromEntries(
    realms.map((realm) => [
      `${home}-${LOGIN}-${realm}`.toLowerCase(),
      { home_account_id: home, environment: LOGIN, realm, local_account_id: oid, username: "alice@example.com", authority_type: "MSSTS" }
    ])
  );
  const RefreshToken = Object.fromEntries(
    refreshTokens.map((owner, i) => [
      `${owner ?? ""}-${LOGIN}-refreshtoken-${AZURE_CLI}--${i}`.toLowerCase(),
      { credential_type: "RefreshToken", secret: "refresh-secret", home_account_id: owner, environment: LOGIN, client_id: AZURE_CLI, family_id: "1" }
    ])
  );
  const AppMetadata = { [`appmetadata-${LOGIN}-${AZURE_CLI}`]: { client_id: AZURE_CLI, environment: LOGIN, family_id: "1" } };
  return gzipSync(Buffer.from(JSON.stringify({ Account, RefreshToken, AppMetadata }))).toString("base64");
}

export const AZURE = azureCacheFor(ALICE.oid);

export function atlassianAuthFor(user: string, refreshToken: string): string {
  return `# twg authentication configuration\nuser=${user}\ntoken=oauth-managed\nsite=hmcts.atlassian.net\noauth-refresh-token=${refreshToken}`;
}

export type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

/** A request as a virtual agent's pod makes it: its launch token and nothing else. */
export async function pod<P>(handler: Handler<P>, token: string, path: string, params: P, method = "GET", body?: unknown): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

export async function orchestrator<P>(handler: Handler<P>, path: string, params: P, method = "GET", body?: unknown, name = "preview-01"): Promise<Response> {
  const request = new Request(`http://localhost:3000${path}`, {
    method,
    headers: { "x-dev-orchestrator": name, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return await handler(request, { params: Promise.resolve(params) });
}

export async function claim(cluster = "preview-01"): Promise<ClaimedVirtualAgent[]> {
  const response = await orchestrator(claimRoute.POST, "/api/orchestrator/claim", {}, "POST", { cluster });
  expect(response.status).toBe(200);
  const body = await jsonOf<ClaimResult>(response);
  expect(body.active).toBe(true);
  return body.virtual_agents;
}

/** The agents a claim by `cluster` gets, failing the test if that cluster is refused the lease. */
export async function claimedBy(cluster: string, now?: Date): Promise<ClaimedVirtualAgent[]> {
  const result = await claimVirtualAgents(prisma, cluster, { now });
  expect(result.active).toBe(true);
  return result.virtual_agents;
}

export async function homeOf(id: string): Promise<string | null> {
  return (await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).cluster;
}

export const LATER = () => new Date(Date.now() + 3 * 60_000);

/**
 * The whole of what a deployment configures about the gateway, which `gatewaySettings` reads per claim. Stubbed for
 * every test below, because the agents here are on the `gateway` route by default and a claim for one is refused
 * without it.
 */
export const GATEWAY_APIM_KEY = "apim-key";

export async function observe(id: string, body: Record<string, unknown>): Promise<Response> {
  return await orchestrator(observedRoute.POST, `/api/orchestrator/virtual-agents/${id}/observed`, { id }, "POST", body);
}

export async function create(owner: Person, name: string, modelRoute: "gateway" | "own-licence" = "gateway"): Promise<VirtualAgentRow> {
  await insertUser(owner);
  return await createVirtualAgent(prisma, { owner, modelRoute, name });
}

/** A virtual agent the orchestrator has claimed and started, with the launch token its pod holds. */
export async function started(owner: Person, name: string, modelRoute: "gateway" | "own-licence" = "gateway"): Promise<{ id: string; token: string }> {
  const row = await create(owner, name, modelRoute);
  const claimed = (await claim()).find((entry) => entry.id === row.id);
  expect(claimed?.launch_token).toBeDefined();
  expect((await observe(row.id, { generation: claimed!.generation, replicas_ready: 1, pod_phase: "Running" })).status).toBe(204);
  return { id: row.id, token: claimed!.launch_token! };
}

export function status(id: string, token: string, body: unknown): Promise<Response> {
  return pod(statusRoute.POST, token, `/api/virtual/${id}/status`, { virtualAgentId: id }, "POST", body);
}

export function ports(id: string, token: string, body: unknown): Promise<Response> {
  return pod(portsRoute.PUT, token, `/api/virtual/${id}/ports`, { virtualAgentId: id }, "PUT", body);
}

export function register(token: string, sessionId: string): Promise<Response> {
  return pod(registerRoute.POST, token, "/api/agent/register", {}, "POST", { session_id: sessionId, name: "va-session" });
}

export function localStore(): SecretStore {
  const backend = credentialBackend(prisma);
  if (!backend.available) {
    throw new Error(backend.reason);
  }
  return backend.store;
}

export function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

export async function row(id: string): Promise<VirtualAgentRow> {
  return (await findVirtualAgent(prisma, id))!;
}

/**
 * The hooks every virtual-agent suite shares: virtual agents on, the session secret, the tenant and the gateway key
 * stubbed, and an empty database for each test. Called at the top level of the suite, after its `vi.mock` calls, so
 * the hooks belong to the file.
 */
export function virtualAgentSuite(): void {
  beforeEach(async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
    vi.stubEnv("SESSION_SECRET", SECRET);
    vi.stubEnv("ENTRA_TENANT_ID", TENANT);
    vi.stubEnv("AI_GATEWAY_APIM_KEY", GATEWAY_APIM_KEY);
    await resetDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });
}
