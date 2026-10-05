import type { JWTVerifyGetKey } from "jose";
import { orchestratorOids } from "../virtual-agents/settings.ts";
import { AgentAuthConfigurationError, type AgentAuthSettings, agentAuthDisabled, agentAuthSettings, type Environment } from "./settings.ts";
import { AgentAuthFailed, verifyEntraToken } from "./token.ts";

/**
 * Who may call `/api/orchestrator/…`: the virtual-agent orchestrator in the preview cluster, signed in as its own
 * application with a client-credentials token. Nothing a person holds is accepted, so a person's `az` token can
 * never claim agents or read launch tokens, and no orchestrator token can act as a person on the agent API.
 */

/** The app role the orchestrator's registration is assigned on this API. */
export const ORCHESTRATE_ROLE = "VirtualAgents.Orchestrate";

/** Local development only, under the same `AGENT_AUTH_DISABLED` as `X-Dev-User`. */
export const DEV_ORCHESTRATOR_HEADER = "x-dev-orchestrator";

export interface Orchestrator {
  oid: string;
  name: string;
}

const BEARER = /^Bearer\s+(\S+)\s*$/i;

const DEV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * An app-only token: no `scp`, which only a delegated token carries, and the orchestrate role in `roles`. Its `oid` is
 * the orchestrator's service principal, which must also be one `ORCHESTRATOR_OIDS` names, so another application
 * that has somehow been given the role is still refused.
 */
export async function verifyOrchestratorToken(
  token: string,
  settings: AgentAuthSettings,
  allowed: readonly string[],
  keys?: JWTVerifyGetKey
): Promise<Orchestrator> {
  const { payload, oid, roles } = await verifyEntraToken(token, settings, keys);
  if (payload.scp !== undefined) {
    throw new AgentAuthFailed("the bearer token is a person's delegated token; the orchestrator signs in as its own application");
  }
  if (!roles.includes(ORCHESTRATE_ROLE)) {
    throw new AgentAuthFailed(`the bearer token does not carry the ${ORCHESTRATE_ROLE} role`);
  }
  if (!allowed.includes(oid)) {
    throw new AgentAuthFailed("the bearer token's application is not an orchestrator this hub trusts");
  }
  const name = typeof payload.azp === "string" && payload.azp !== "" ? payload.azp : oid;
  return { oid, name };
}

export async function authenticateOrchestrator(headers: Headers, env: Environment = process.env, keys?: JWTVerifyGetKey): Promise<Orchestrator> {
  if (agentAuthDisabled(env)) {
    const name = headers.get(DEV_ORCHESTRATOR_HEADER)?.trim() ?? "";
    if (!DEV_NAME.test(name)) {
      throw new AgentAuthFailed("AGENT_AUTH_DISABLED is set, so send X-Dev-Orchestrator: <name>");
    }
    return { oid: `dev-orchestrator-${name}`, name };
  }
  const token = BEARER.exec(headers.get("authorization") ?? "")?.[1];
  if (token === undefined) {
    throw new AgentAuthFailed("send Authorization: Bearer <the orchestrator's client-credentials token>");
  }
  const allowed = orchestratorOids(env);
  if (allowed.length === 0) {
    throw new AgentAuthConfigurationError("ORCHESTRATOR_OIDS is not set, so no orchestrator can be trusted");
  }
  return await verifyOrchestratorToken(token, agentAuthSettings(env), allowed, keys);
}
