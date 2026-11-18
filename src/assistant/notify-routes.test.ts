import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../agent-api/http.ts";

const store = vi.hoisted(() => ({ notifyView: vi.fn(), writeAgentNotify: vi.fn() }));

vi.mock("@/store/prisma", () => ({ prisma: {} }));
vi.mock("@/agent-api/route", () => ({
  ownedAgentRoute: (handler: (request: unknown) => Promise<Response>) => (request: Request, context: { params: Promise<unknown> }) =>
    context.params.then((params) => handler({ agent: { id: "agent-1" }, request, params }))
}));
vi.mock("@/assistant/conversation-store", () => ({ requireConversationOfAgent: async () => ({ id: "conv-1" }) }));
vi.mock("@/assistant/notify-store", () => store);

const route = await import("../app/api/agent/[agentId]/notify/route.ts");

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

describe("the agent API's notify route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("should answer the latest version, or the one asked for", async () => {
    store.notifyView.mockResolvedValue({ version: 2 });

    const latest = await route.GET(new Request("http://localhost/x"), params);
    const asked = await route.GET(new Request("http://localhost/x?version=1"), params);

    expect(await latest.json()).toEqual({ version: 2 });
    expect(asked.status).toBe(200);
    expect(store.notifyView).toHaveBeenNthCalledWith(1, {}, "conv-1", undefined);
    expect(store.notifyView).toHaveBeenNthCalledWith(2, {}, "conv-1", 1);
  });

  it("should answer 404 when there is no template or no such version, and 400 for a version that is not one", async () => {
    store.notifyView.mockResolvedValue(null);

    expect((await refusal(route.GET(new Request("http://localhost/x"), params))).message).toBe("the conversation has no Notify template");
    expect((await refusal(route.GET(new Request("http://localhost/x?version=3"), params))).message).toBe("the template does not keep version 3");
    expect((await refusal(route.GET(new Request("http://localhost/x?version=zero"), params))).status).toBe(400);
  });

  it("should write a checked put as the session's version", async () => {
    store.writeAgentNotify.mockResolvedValue({ version: 1, revision: 0 });

    const response = await route.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify(BODY) }), params);

    expect(await response.json()).toEqual({ version: 1, revision: 0 });
    expect(store.writeAgentNotify).toHaveBeenCalledWith({}, { conversationId: "conv-1", body: BODY });
  });

  it("should refuse a put the checks refuse with 400, naming the field", async () => {
    const error = await refusal(route.PUT(new Request("http://localhost/x", { method: "PUT", body: JSON.stringify({ ...BODY, body: 7 }) }), params));

    expect(error.status).toBe(400);
    expect(error.message).toMatch(/^body /);
    expect(store.writeAgentNotify).not.toHaveBeenCalled();
  });
});
