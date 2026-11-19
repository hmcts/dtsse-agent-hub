import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";

const store = vi.hoisted(() => ({
  notifyView: vi.fn(),
  primaryNotifyView: vi.fn(),
  listNotifySummaries: vi.fn(),
  removeNotify: vi.fn(),
  writeAgentNotify: vi.fn()
}));

vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/agent-api/route", () => ({
  ownedAgentRoute: (handler: (request: unknown) => Promise<Response>) => (request: Request, context: { params: Promise<unknown> }) =>
    context.params.then((params) => handler({ agent: { id: "agent-1" }, request, params }))
}));
vi.mock("@/assistant/conversation-store", () => ({ requireConversationOfAgent: async () => ({ id: "conv-1" }) }));
vi.mock("@/assistant/notify-store", async (actual) => ({ ...(await actual<typeof import("./notify-store.ts")>()), ...store }));

const route = await import("../app/api/agent/[agentId]/notify/route.ts");
const listRoute = await import("../app/api/agent/[agentId]/notify-templates/route.ts");
const itemRoute = await import("../app/api/agent/[agentId]/notify-templates/[itemId]/route.ts");
const ITEM = "0b1f3d4a-0000-4000-8000-0000000000c1";
const itemParams = { params: Promise.resolve({ agentId: "agent-1", itemId: ITEM }) };

const params = { params: Promise.resolve({ agentId: "agent-1" }) };
const BODY = {
  subject: "Claim",
  body: "Dear ((name))",
  data: {},
  base_version: 0,
  source: {
    product: "pcs",
    template_id: "ab1f3d4a-0000-4000-8000-000000000002",
    service_id: "5c1f3d4a-0000-4000-8000-000000000001",
    type: "email",
    name: "Claim received",
    notify_version: 4,
    notify_subject: "Claim",
    notify_body: "Dear ((name))",
    notify_preview: null
  }
};

async function refusal(call: Promise<unknown>): Promise<HttpError> {
  const error = await call.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe("the agent API's primary notify route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should answer the latest version, or the one asked for", async () => {
    store.primaryNotifyView.mockResolvedValue({ version: 2 });

    const latest = await route.GET(new Request("http://localhost/x"), params);
    const asked = await route.GET(new Request("http://localhost/x?version=1"), params);

    expect(await latest.json()).toEqual({ version: 2 });
    expect(asked.status).toBe(200);
    expect(store.primaryNotifyView).toHaveBeenNthCalledWith(1, {}, "conv-1", undefined);
    expect(store.primaryNotifyView).toHaveBeenNthCalledWith(2, {}, "conv-1", 1);
  });

  it("should answer 404 when there is no template or no such version, and 400 for a version that is not one", async () => {
    store.primaryNotifyView.mockResolvedValue(null);

    expect((await refusal(route.GET(new Request("http://localhost/x"), params))).message).toBe("the conversation has no Notify template");
    expect((await refusal(route.GET(new Request("http://localhost/x?version=3"), params))).message).toBe("the template does not keep version 3");
    expect((await refusal(route.GET(new Request("http://localhost/x?version=zero"), params))).status).toBe(400);
  });

  it("should write a checked put as the session's version", async () => {
    store.writeAgentNotify.mockResolvedValue({ id: ITEM, version: 1, revision: 0 });

    const response = await route.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(BODY) }), params);

    expect(await response.json()).toEqual({ version: 1, revision: 0 });
    expect(store.writeAgentNotify).toHaveBeenCalledWith({}, { conversationId: "conv-1", target: "primary", body: BODY });
  });

  it("should refuse a put the checks refuse with 400, naming the field", async () => {
    const error = await refusal(route.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ ...BODY, body: 7 }) }), params));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^body /);
    expect(store.writeAgentNotify).not.toHaveBeenCalled();
  });
});

describe("the agent API's notify-templates routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should list the templates oldest first as summaries", async () => {
    store.listNotifySummaries.mockResolvedValue([{ id: ITEM, name: "Claim received", version: 2, revision: 1, updatedBy: "user" }]);

    const response = await listRoute.GET(new Request("http://localhost/x"), params);

    expect(await response.json()).toEqual({ notify_templates: [{ id: ITEM, name: "Claim received", version: 2, revision: 1, updated_by: "user" }] });
  });

  it("should make a new template for a post at base 0, and refuse a post at any other base", async () => {
    store.writeAgentNotify.mockResolvedValue({ id: ITEM, version: 1, revision: 0 });

    const made = await listRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(BODY) }), params);
    const refused = await refusal(
      listRoute.POST(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ ...BODY, base_version: 1 }) }), params)
    );

    expect(made.status).toBe(201);
    expect(await made.json()).toEqual({ id: ITEM, version: 1, revision: 0 });
    expect(store.writeAgentNotify).toHaveBeenCalledWith({}, { conversationId: "conv-1", target: "new", body: BODY });
    expect(refused.status).toBe(400);
  });

  it("should read, write and remove one template by its id", async () => {
    store.notifyView.mockResolvedValue({ version: 3 });
    store.writeAgentNotify.mockResolvedValue({ id: ITEM, version: 4, revision: 0 });

    const read = await itemRoute.GET(new Request("http://localhost/x?version=2"), itemParams);
    const written = await itemRoute.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ ...BODY, base_version: 3 }) }), itemParams);
    const removed = await itemRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), itemParams);

    expect(await read.json()).toEqual({ version: 3 });
    expect(store.notifyView).toHaveBeenCalledWith({}, "conv-1", ITEM, 2);
    expect(await written.json()).toEqual({ version: 4, revision: 0 });
    expect(store.writeAgentNotify).toHaveBeenCalledWith({}, { conversationId: "conv-1", target: { item: ITEM }, body: { ...BODY, base_version: 3 } });
    expect(removed.status).toBe(204);
    expect(store.removeNotify).toHaveBeenCalledWith({}, { id: "conv-1" }, ITEM);
  });

  it("should answer 404 for an id that is not a uuid and for a template that is not there", async () => {
    store.notifyView.mockResolvedValue(null);

    const bad = await refusal(itemRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ agentId: "agent-1", itemId: "nope" }) }));
    const gone = await refusal(itemRoute.GET(new Request("http://localhost/x"), itemParams));

    expect(bad.status).toBe(404);
    expect(gone.status).toBe(404);
  });
});
