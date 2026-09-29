import { authenticateAgent } from "../agent-auth/authenticate.ts";
import { AgentAuthConfigurationError } from "../agent-auth/settings.ts";
import { AgentAuthFailed } from "../agent-auth/token.ts";
import { type AgentRow, findAgent, isUuid } from "../agents/store.ts";
import { prisma } from "../store/prisma.ts";
import { InvalidTopics } from "../topics/slug.ts";
import type { Identity } from "../users/identity.ts";
import { upsertUser } from "../users/store.ts";
import { errorResponse, HttpError } from "./http.ts";

/**
 * The wrappers every `/api/agent/*` handler is written inside: authenticate the bearer token, record the caller,
 * and render every refusal as the contract's `{"error": …}`.
 */

export interface AgentRequest<P> {
  caller: Identity;
  request: Request;
  params: P;
}

export interface OwnedAgentRequest<P> extends AgentRequest<P> {
  agent: AgentRow;
}

type Context<P> = { params: Promise<P> };

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
  if (error instanceof AgentAuthConfigurationError) {
    console.error(`agent authentication is misconfigured: ${error.message}`);
    return errorResponse(503, "agent authentication is not configured on this deployment");
  }
  console.error(`an agent API request failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  return errorResponse(500, "internal error");
}

export function agentRoute<P = Record<string, never>>(handler: (request: AgentRequest<P>) => Promise<Response>) {
  return async (request: Request, context: Context<P>): Promise<Response> => {
    try {
      const caller = await authenticateAgent(request.headers);
      await upsertUser(prisma, caller);
      return await handler({ caller, request, params: await context.params });
    } catch (error) {
      return refusal(error);
    }
  };
}

/** For `/api/agent/{agent_id}/…`: the caller must own the agent. */
export function ownedAgentRoute<P extends { agentId: string }>(handler: (request: OwnedAgentRequest<P>) => Promise<Response>) {
  return agentRoute<P>(async (request) => {
    const agent = isUuid(request.params.agentId) ? await findAgent(prisma, request.params.agentId) : undefined;
    if (agent === undefined) {
      throw new HttpError(404, "no such agent");
    }
    if (agent.ownerOid !== request.caller.oid) {
      throw new HttpError(403, "that agent belongs to someone else");
    }
    return await handler({ ...request, agent });
  });
}
