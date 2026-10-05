import type { JWTVerifyGetKey } from "jose";
import type { Identity } from "../users/identity.ts";
import { looksLikeLaunchToken } from "../virtual-agents/launch-token.ts";
import { virtualAgentsEnabled } from "../virtual-agents/settings.ts";
import { DEV_USER_HEADER, parseDevUser } from "./dev.ts";
import { agentAuthDisabled, agentAuthSettings, type Environment } from "./settings.ts";
import { AgentAuthFailed, verifyAgentToken } from "./token.ts";

const BEARER = /^Bearer\s+(\S+)\s*$/i;

/**
 * Who is calling the agent API. A person with their own token, or a virtual agent's pod with its launch token, which
 * acts as the virtual agent's owner and carries `virtualAgentId` so every route can tell the two apart.
 */
export type Caller = Identity & { virtualAgentId?: string };

/** The caller a launch token stands for, or `undefined` when it stands for nobody. */
export type LaunchTokenResolver = (token: string) => Promise<Caller | undefined>;

/**
 * Who is calling the agent API, or `AgentAuthFailed`.
 *
 * A bearer starting `ahv_` is a launch token, which is never an Entra token, so it is looked up rather than verified.
 * It is accepted whether or not `AGENT_AUTH_DISABLED` is set, since a development pod has no other way to say which
 * virtual agent it is; with virtual agents off it is just another token that does not verify.
 */
export async function authenticateAgent(
  headers: Headers,
  env: Environment = process.env,
  keys?: JWTVerifyGetKey,
  launchTokens?: LaunchTokenResolver
): Promise<Caller> {
  const disabled = agentAuthDisabled(env);
  const token = BEARER.exec(headers.get("authorization") ?? "")?.[1];

  if (token !== undefined && looksLikeLaunchToken(token) && launchTokens !== undefined && virtualAgentsEnabled(env)) {
    const caller = await launchTokens(token);
    if (caller === undefined) {
      throw new AgentAuthFailed("the launch token was refused: it is unknown, has been replaced, or its virtual agent is not meant to be running");
    }
    return caller;
  }

  if (disabled) {
    const developer = parseDevUser(headers.get(DEV_USER_HEADER));
    if (developer === undefined) {
      throw new AgentAuthFailed("AGENT_AUTH_DISABLED is set, so send X-Dev-User: <oid>|<name>|<email>");
    }
    return developer;
  }

  if (token === undefined) {
    throw new AgentAuthFailed("send Authorization: Bearer <token from az account get-access-token>");
  }
  return await verifyAgentToken(token, agentAuthSettings(env), keys);
}
