import type { JWTVerifyGetKey } from "jose";
import type { Identity } from "../users/identity.ts";
import { DEV_USER_HEADER, parseDevUser } from "./dev.ts";
import { agentAuthDisabled, agentAuthSettings, type Environment } from "./settings.ts";
import { AgentAuthFailed, verifyAgentToken } from "./token.ts";

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/** Who is calling the agent API, or `AgentAuthFailed`. */
export async function authenticateAgent(headers: Headers, env: Environment = process.env, keys?: JWTVerifyGetKey): Promise<Identity> {
  if (agentAuthDisabled(env)) {
    const developer = parseDevUser(headers.get(DEV_USER_HEADER));
    if (developer === undefined) {
      throw new AgentAuthFailed("AGENT_AUTH_DISABLED is set, so send X-Dev-User: <oid>|<name>|<email>");
    }
    return developer;
  }

  const token = BEARER.exec(headers.get("authorization") ?? "")?.[1];
  if (token === undefined) {
    throw new AgentAuthFailed("send Authorization: Bearer <token from az account get-access-token>");
  }
  return await verifyAgentToken(token, agentAuthSettings(env), keys);
}
