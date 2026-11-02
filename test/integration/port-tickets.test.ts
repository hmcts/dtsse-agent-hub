// The viewer's ticket route on the hub's host, end to end through Postgres: who is handed a ticket to open one of a
// virtual agent's web servers, and who is answered as if there were nothing there.
//
// What the viewer does with the ticket is in `src/port-viewer/serve.test.ts`; where the old address goes is in
// `src/web/home.test.ts` and `src/__tests__/proxy.test.ts`.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ticketRoute from "../../src/app/assistant/ports/[id]/[port]/route.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { openTicket } from "../../src/port-viewer/tickets.ts";
import { reportPorts, setDesired } from "../../src/virtual-agents/store.ts";
import { ALICE, BOB, viewer } from "./assistant-pod.ts";
import { insertUser, prisma, resetDatabase } from "./database.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());

const { actAs } = await import("./web-session.ts");

const SECRET = "a-test-session-secret-long-enough-to-be-plausible";
const VIEWER_HOST = "agent-hub-viewer.example";

beforeEach(async () => {
  await resetDatabase();
  actAs("alice");
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
  vi.stubEnv("SESSION_SECRET", SECRET);
  vi.stubEnv("AGENT_HUB_VIEWER_HOST", VIEWER_HOST);
  vi.stubEnv("ENTRA_REDIRECT_URI", "https://agent-hub.example/auth/callback");
});

/** Alice's assistant, its pod reporting a server on 3000. */
async function servingAssistant(): Promise<string> {
  await insertUser(ALICE);
  const assistant = await ensureAssistant(prisma, viewer(ALICE));
  await reportPorts(prisma, assistant.id, { ports: [3000], localOnly: [] });
  return assistant.id;
}

async function open(id: string, port: string, query = ""): Promise<Response> {
  const request = new NextRequest(`https://agent-hub.example/assistant/ports/${id}/${port}${query}`);
  return await ticketRoute.GET(request, { params: Promise.resolve({ id, port }) });
}

describe("GET /assistant/ports/{id}/{port}", () => {
  it("should send the owner to the viewer with a ticket for that port and path when the pod reports the port", async () => {
    const id = await servingAssistant();

    const response = await open(id, "3000", `?${new URLSearchParams({ path: "/docs?page=2" })}`);

    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`https://${VIEWER_HOST}/_auth`);
    expect(await openTicket(location.searchParams.get("ticket"), SECRET)).toMatchObject({
      oid: ALICE.oid,
      virtualAgentId: id,
      port: 3000,
      path: "/docs?page=2"
    });
  });

  it("should answer an upper-case id as its own agent when the owner opens it", async () => {
    const id = await servingAssistant();

    expect((await open(id.toUpperCase(), "3000")).status).toBe(303);
  });

  it("should answer not found when somebody other than the owner asks", async () => {
    const id = await servingAssistant();
    await insertUser(BOB);
    actAs("bob");

    const response = await open(id, "3000");

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("should answer not found when the pod does not report the port", async () => {
    const id = await servingAssistant();

    expect((await open(id, "5173")).status).toBe(404);
  });

  it("should answer not found when the agent has been stopped", async () => {
    const id = await servingAssistant();
    await setDesired(prisma, ALICE.oid, id, "stopped");

    expect((await open(id, "3000")).status).toBe(404);
  });

  // Deleting clears the ports, so they are put back: a pod still reporting while it is taken down is the case the
  // route's own check on `desired` is there for.
  it("should answer not found when the agent is being deleted and its pod still reports the port", async () => {
    const id = await servingAssistant();
    await setDesired(prisma, ALICE.oid, id, "deleted");
    await prisma.virtualAgent.update({ where: { id }, data: { exposedPorts: [3000] } });

    expect((await open(id, "3000")).status).toBe(404);
  });

  it("should answer not found when there is no such agent", async () => {
    await servingAssistant();

    expect((await open("0f8a6a1e-0000-4000-8000-000000000001", "3000")).status).toBe(404);
  });

  it.each(["not-a-uuid", "0f8a"])("should answer not found when the id %s is not a virtual agent's", async (id) => {
    expect((await open(id, "3000")).status).toBe(404);
  });

  it.each(["08080", "80", "99999", "x"])("should answer not found when the port %s is not one a pod can report", async (port) => {
    const id = await servingAssistant();

    expect((await open(id, port)).status).toBe(404);
  });

  it("should answer not found when virtual agents are off", async () => {
    const id = await servingAssistant();
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "");

    expect((await open(id, "3000")).status).toBe(404);
  });

  it("should answer not found when the viewer has no host of its own", async () => {
    const id = await servingAssistant();
    vi.stubEnv("AGENT_HUB_VIEWER_HOST", "");

    expect((await open(id, "3000")).status).toBe(404);
  });
});
