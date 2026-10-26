import { afterEach, describe, expect, it, vi } from "vitest";
import { lookUp } from "./lookupClient.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown) {
  const fetch = vi.fn(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("lookUp", () => {
  it("should post the search to the hub and answer what it said", async () => {
    const fetch = stubFetch(200, { status: "waking" });
    const signal = new AbortController().signal;

    expect(await lookUp({ kind: "confluence_page", query: "flags", space: "CCD" }, signal)).toEqual({ status: "waking" });
    expect(fetch).toHaveBeenCalledWith("/api/ui/assistant/lookups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "confluence_page", query: "flags", space: "CCD", sign_in: false }),
      signal
    });
  });

  it("should ask for the sign-in when the person asked for one", async () => {
    const fetch = stubFetch(200, { status: "signing_in" });

    await lookUp({ kind: "jira_project", query: "", space: null, signIn: true }, new AbortController().signal);

    expect(JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toMatchObject({ sign_in: true });
  });

  it("should read a refusal as a failure in the hub's own words, or a plain one", async () => {
    stubFetch(429, { error: "that is a lot of searches at once; wait a moment and try again" });
    expect(await lookUp({ kind: "jira_project", query: "vibe", space: null }, new AbortController().signal)).toEqual({
      status: "failed",
      detail: "that is a lot of searches at once; wait a moment and try again"
    });

    stubFetch(500, "not json");
    expect(await lookUp({ kind: "jira_project", query: "vibe", space: null }, new AbortController().signal)).toEqual({
      status: "failed",
      detail: "The search did not work. Try again."
    });
  });
});
