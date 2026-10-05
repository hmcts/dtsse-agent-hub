import { canActAsVirtualAgent, canLaunchTokenActForAgent } from "../access/rules.ts";
import { authenticateAgent, type Caller } from "../agent-auth/authenticate.ts";
import { authenticateOrchestrator, type Orchestrator } from "../agent-auth/orchestrator.ts";
import { AgentAuthConfigurationError } from "../agent-auth/settings.ts";
import { AgentAuthFailed, AgentAuthUnavailable } from "../agent-auth/token.ts";
import { type AgentRow, findAgent, isUuid } from "../agents/store.ts";
import { prisma } from "../store/prisma.ts";
import { InvalidTopics } from "../topics/slug.ts";
import { upsertUser } from "../users/store.ts";
import { virtualAgentsEnabled } from "../virtual-agents/settings.ts";
import { callerForLaunchToken, findVirtualAgent, type VirtualAgentRow } from "../virtual-agents/store.ts";
import { errorResponse, HttpError } from "./http.ts";

/**
 * The wrappers every `/api/agent/*`, `/api/virtual/*` and `/api/orchestrator/*` handler is written inside:
 * authenticate the bearer token, record the caller, and render every refusal as the contract's `{"error": …}`.
 */

export interface AgentRequest<P> {
  caller: Caller;
  request: Request;
  params: P;
}

export interface OwnedAgentRequest<P> extends AgentRequest<P> {
  agent: AgentRow;
}

export interface VirtualAgentRequest<P> {
  caller: Caller & { virtualAgentId: string };
  virtualAgent: VirtualAgentRow;
  request: Request;
  params: P;
}

export interface OrchestratorRequest<P> {
  orchestrator: Orchestrator;
  request: Request;
  params: P;
}

type Context<P> = { params: Promise<P> };

const KEYS_RETRY_AFTER_SECONDS = 10;

function refusal(error: unknown): Response {
  if (error instanceof HttpError) {
    return errorResponse(error.status, error.message, error.extra);
  }
  if (error instanceof InvalidTopics) {
    return errorResponse(400, error.message);
  }
  if (error instanceof AgentAuthFailed) {
    return errorResponse(401, error.message, {}, { "www-authenticate": 'Bearer realm="dtsse-agent-hub"' });
  }
  if (error instanceof AgentAuthUnavailable) {
    console.error(`agent authentication is unavailable: ${error.message}`);
    return errorResponse(503, "agent tokens cannot be checked right now; retry shortly", {}, { "retry-after": String(KEYS_RETRY_AFTER_SECONDS) });
  }
  if (error instanceof AgentAuthConfigurationError) {
    console.error(`agent authentication is misconfigured: ${error.message}`);
    return errorResponse(503, "agent authentication is not configured on this deployment");
  }
  console.error(`an agent API request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return errorResponse(500, "internal error");
}

function authenticate(request: Request): Promise<Caller> {
  return authenticateAgent(request.headers, process.env, undefined, (token) => callerForLaunchToken(prisma, token));
}

/**
 * A launch token's owner already has a `user` row, which the token was looked up through, and nothing the pod sends
 * should rewrite it, so only a person's own token refreshes it.
 */
export function agentRoute<P = Record<string, never>>(handler: (request: AgentRequest<P>) => Promise<Response>) {
  return async (request: Request, context: Context<P>): Promise<Response> => {
    try {
      const caller = await authenticate(request);
      if (caller.virtualAgentId === undefined) {
        await upsertUser(prisma, caller);
      }
      return await handler({ caller, request, params: await context.params });
    } catch (error) {
      return refusal(error);
    }
  };
}

/**
 * For `/api/agent/{agent_id}/…`: the caller must own the agent, and a launch token must also be acting for an agent
 * its own virtual agent registered.
 */
export function ownedAgentRoute<P extends { agentId: string }>(handler: (request: OwnedAgentRequest<P>) => Promise<Response>) {
  return agentRoute<P>(async (request) => {
    const agent = isUuid(request.params.agentId) ? await findAgent(prisma, request.params.agentId) : undefined;
    if (agent === undefined) {
      throw new HttpError(404, "no such agent");
    }
    if (agent.ownerOid !== request.caller.oid) {
      throw new HttpError(403, "that agent belongs to someone else");
    }
    const tokenFor = request.caller.virtualAgentId;
    if (tokenFor !== undefined && !canLaunchTokenActForAgent(tokenFor, agent)) {
      throw new HttpError(403, "a virtual agent's launch token acts only for the agents that virtual agent registered");
    }
    return await handler({ ...request, agent });
  });
}

const NOT_FOUND = "not found";

/** For `/api/virtual/{virtualAgentId}/…`: only that virtual agent's own launch token. Answers 404 with the feature off. */
export function virtualRoute<P extends { virtualAgentId: string }>(handler: (request: VirtualAgentRequest<P>) => Promise<Response>) {
  return async (request: Request, context: Context<P>): Promise<Response> => {
    try {
      if (!virtualAgentsEnabled()) {
        throw new HttpError(404, NOT_FOUND);
      }
      const caller = await authenticate(request);
      const params = await context.params;
      const tokenFor = caller.virtualAgentId;
      if (tokenFor === undefined || !canActAsVirtualAgent(tokenFor, params.virtualAgentId)) {
        throw new HttpError(403, "only this virtual agent's own launch token may call its routes");
      }
      const virtualAgent = await findVirtualAgent(prisma, tokenFor);
      if (virtualAgent === undefined) {
        throw new HttpError(404, "no such virtual agent");
      }
      return await handler({ caller: { ...caller, virtualAgentId: tokenFor }, virtualAgent, request, params });
    } catch (error) {
      return refusal(error);
    }
  };
}

/** For `/api/orchestrator/…`: only the orchestrator's own application token. Answers 404 with the feature off. */
export function orchestratorRoute<P = Record<string, never>>(handler: (request: OrchestratorRequest<P>) => Promise<Response>) {
  return async (request: Request, context: Context<P>): Promise<Response> => {
    try {
      if (!virtualAgentsEnabled()) {
        throw new HttpError(404, NOT_FOUND);
      }
      const orchestrator = await authenticateOrchestrator(request.headers);
      return await handler({ orchestrator, request, params: await context.params });
    } catch (error) {
      return refusal(error);
    }
  };
}
