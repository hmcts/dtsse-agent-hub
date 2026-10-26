import type { LookupKind, LookupResponse } from "@/assistant/lookups";

/** One search of the person's own Jira or Confluence, through their assistant. See "Atlassian lookups" in docs/agent-api.md. */
export interface LookupRequest {
  kind: LookupKind;
  query: string;
  /** A Confluence space key to search in, or null for all of Confluence. */
  space: string | null;
  signIn?: boolean;
}

export type LookUp = (request: LookupRequest, signal: AbortSignal) => Promise<LookupResponse>;

/** The browser's end of `POST /api/ui/assistant/lookups`. A refusal reads as a failure with the hub's own words. */
export const lookUp: LookUp = async (request, signal) => {
  const response = await fetch("/api/ui/assistant/lookups", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: request.kind, query: request.query, space: request.space, sign_in: request.signIn === true }),
    signal
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    return { status: "failed", detail: typeof body.error === "string" ? body.error : "The search did not work. Try again." };
  }
  return (await response.json()) as LookupResponse;
};
