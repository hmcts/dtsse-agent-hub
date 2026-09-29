import { issuerUrl } from "../auth/settings.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

/** The Application ID URI the Azure CLI asks for a token against: `az account get-access-token --scope api://dtsse-agent-hub/.default`. */
export const DEFAULT_AUDIENCE = "api://dtsse-agent-hub";

export interface AgentAuthSettings {
  tenantId: string;
  issuer: string;
  /**
   * Every `aud` accepted. A v2 access token names the application by its client id rather than by the URI the scope
   * was requested with, so both are accepted.
   */
  audiences: string[];
}

export class AgentAuthConfigurationError extends Error {}

/**
 * Local development only. The contract lets a client send `X-Dev-User` instead of a bearer token when the service
 * runs with this set; no chart sets it. Every production build refuses it, the runtime image included, so a
 * deployment that sets it by mistake answers every agent request 503 rather than trusting a header anyone can send.
 */
export function agentAuthDisabled(env: Environment = process.env): boolean {
  const disabled = env.AGENT_AUTH_DISABLED === "true";
  if (disabled && env.NODE_ENV === "production") {
    throw new AgentAuthConfigurationError("AGENT_AUTH_DISABLED is set on a production build; it is for next dev only");
  }
  return disabled;
}

export function agentAuthSettings(env: Environment = process.env): AgentAuthSettings {
  const tenantId = env.ENTRA_TENANT_ID?.trim();
  if (!tenantId) {
    throw new AgentAuthConfigurationError("ENTRA_TENANT_ID is not set, so agent tokens cannot be validated");
  }
  const configured = (env.AGENT_API_AUDIENCE ?? DEFAULT_AUDIENCE)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const clientId = env.ENTRA_CLIENT_ID?.trim();
  const audiences = [...new Set([...configured, ...(clientId ? [clientId] : [])])];
  if (audiences.length === 0) {
    throw new AgentAuthConfigurationError("no audience is configured: set AGENT_API_AUDIENCE or ENTRA_CLIENT_ID");
  }
  return { tenantId, issuer: issuerUrl(tenantId).toString(), audiences };
}

export function jwksUrl(tenantId: string): URL {
  return new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`);
}
