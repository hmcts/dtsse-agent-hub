import type { TokenCredential } from "@azure/identity";
import type { VirtualAgentSize } from "../virtual-agents/size.ts";
import { withoutTrailingSlashes } from "./settings.ts";

/**
 * The hub's `/api/orchestrator/**` routes in `docs/agent-api.md`, called with the orchestrator's own app-only token.
 * A claim's launch tokens are in the response and nowhere else, so no response body is ever logged or put in an error.
 */

export type Desired = "running" | "stopped" | "deleted";

export type ModelRoute = "bedrock" | "own_licence";

export interface ClaimedAgent {
  id: string;
  generation: number;
  /** What the pod template is stamped with; `generation` when absent. A change of ports alone leaves it as it was. */
  pod_generation?: number;
  desired: Desired;
  statefulset_name: string;
  pvc_name: string;
  delete_disk: boolean;
  model_route: ModelRoute;
  /** The StatefulSet is sized `small` when this is absent or not a size it knows. */
  size?: VirtualAgentSize;
  /** The ports the pod reports listening on beyond loopback, ascending; treated as none when absent. */
  exposed_ports?: number[];
  owner: { oid: string };
  launch_token?: string;
}

export interface ObservedBody {
  generation: number;
  replicas_ready: number;
  pod_phase: string | null;
  reason: string | null;
  disk_deleted: boolean;
}

export interface LiveAgent {
  id: string;
  statefulset_name: string;
  pvc_name: string | null;
  /** The cluster the hub has the agent on; `null` before it is first claimed. */
  cluster: string | null;
}

export interface Lease {
  cluster: string;
  renewed_at: string;
}

/** The agents claimed while this cluster holds the hub's lease, or the holder while another does. */
export type Claim = { active: true; agents: ClaimedAgent[] } | { active: false; lease: Lease };

export interface Hub {
  claim(cluster: string): Promise<Claim>;
  observed(id: string, body: ObservedBody): Promise<void>;
  live(): Promise<LiveAgent[]>;
}

export class HubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export interface HubOptions {
  url: string;
  scope: string;
  credential: TokenCredential;
  fetch?: typeof fetch;
  attempts?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** What is worth trying again: the hub restarting or briefly overloaded, not a request it refused. */
function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function errorOf(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : `${response.status}`;
  } catch {
    return `${response.status}`;
  }
}

interface AgentList<T> {
  virtual_agents: T[];
  active?: unknown;
  lease?: unknown;
}

/** A parse error quotes the body, and a claim's body holds launch tokens, so the error names only the request. */
async function agentsOf<T>(response: Response, request: string): Promise<AgentList<T>> {
  try {
    const parsed = (await response.json()) as { virtual_agents?: unknown };
    if (Array.isArray(parsed.virtual_agents)) {
      return parsed as AgentList<T>;
    }
  } catch {}
  throw new Error(`${request}: the hub's answer was not a list of virtual agents`);
}

function isLease(value: unknown): value is Lease {
  const lease = value as Partial<Lease> | null;
  return typeof lease === "object" && lease !== null && typeof lease.cluster === "string" && typeof lease.renewed_at === "string";
}

export function createHub({
  url,
  scope,
  credential,
  fetch: send = fetch,
  attempts = 4,
  backoffMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}: HubOptions): Hub {
  const base = withoutTrailingSlashes(url);

  /** One attempt: the response, or the network or token failure that stopped it getting one. */
  async function attempt(method: string, path: string, body: unknown): Promise<Response | Error> {
    try {
      const token = await credential.getToken(scope);
      if (token === null) {
        throw new Error(`no token for ${scope}`);
      }
      return await send(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      return new Error(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Sequential on purpose: each retry waits out the backoff after the attempt before it.
  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    let failure: Error = new Error(`${method} ${path} was not attempted`);
    for (let tries = 1; tries <= attempts; tries += 1) {
      if (tries > 1) {
        await sleep(backoffMs * 2 ** (tries - 2));
      }
      const outcome = await attempt(method, path, body);
      if (outcome instanceof Error) {
        failure = outcome;
      } else if (outcome.ok) {
        return outcome;
      } else {
        failure = new HubError(`${method} ${path}: ${outcome.status} ${await errorOf(outcome)}`, outcome.status);
        if (!retryable(outcome.status)) {
          break;
        }
      }
    }
    throw failure;
  }

  return {
    async claim(cluster) {
      const request = "POST /api/orchestrator/claim";
      const answer = await agentsOf<ClaimedAgent>(await call("POST", "/api/orchestrator/claim", { cluster }), request);
      if (answer.active !== false) {
        return { active: true, agents: answer.virtual_agents };
      }
      if (!isLease(answer.lease)) {
        throw new Error(`${request}: the hub said this cluster is on standby but not who holds the lease`);
      }
      return { active: false, lease: { cluster: answer.lease.cluster, renewed_at: answer.lease.renewed_at } };
    },

    async observed(id, body) {
      await call("POST", `/api/orchestrator/virtual-agents/${encodeURIComponent(id)}/observed`, body);
    },

    async live() {
      const response = await call("GET", "/api/orchestrator/live");
      return (await agentsOf<LiveAgent>(response, "GET /api/orchestrator/live")).virtual_agents;
    }
  };
}
