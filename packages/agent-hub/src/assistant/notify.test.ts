import type { NotifyTemplate } from "@hmcts-cft/docmosis-tools/notify";
import { KeyVaultError, NotifyApiError } from "@hmcts-cft/docmosis-tools/notify/node";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.ts";
import type { NotifyBody, NotifyResponse } from "../wire.ts";
import { listNotifyTemplates, type NotifyDeps, notifyFailure, notifyProducts, productOf, pullNotifyTemplate } from "./notify.ts";
import { MAX_BODY, MAX_PREVIEW_BYTES } from "./notify-tools.ts";
import { PodJobError } from "./pod-jobs.ts";

const PRODUCTS = [{ id: "pcs", label: "PCS", vault: "pcs-aat", secret: "gov-notify-key" }];
const SERVICE = "5c1f3d4a-0000-4000-8000-000000000001";
const TEMPLATE_ID = "AB1F3D4A-0000-4000-8000-000000000002";
const KEY = "key-name-5c1f3d4a-0000-4000-8000-000000000001-6d2e4c5b-0000-4000-8000-000000000003";

function template(overrides: Partial<NotifyTemplate> = {}): NotifyTemplate {
  return { id: TEMPLATE_ID, type: "email", name: "Claim received", version: 4, subject: "Your claim ((ref))", body: "Dear ((name))", ...overrides };
}

function fakes({
  templates = [template()],
  got = template(),
  preview = { id: TEMPLATE_ID, type: "email" as const, version: 4, body: "Dear ((name))", html: "<p>Dear ((name))</p>" } as unknown,
  read = async () => KEY
}: {
  templates?: NotifyTemplate[];
  got?: NotifyTemplate;
  preview?: unknown;
  read?: (vault: string, secret: string) => Promise<string>;
} = {}) {
  const client = {
    serviceId: SERVICE,
    listTemplates: vi.fn(async () => templates),
    getTemplate: vi.fn(async () => got),
    previewTemplate: vi.fn(async () => {
      if (preview instanceof Error) {
        throw preview;
      }
      return preview as never;
    })
  };
  const readKey = vi.fn(read);
  const deps: NotifyDeps = { products: PRODUCTS, readKey, client: () => client };
  return { client, readKey, deps };
}

const ITEM_ID = "0b1f3d4a-0000-4000-8000-0000000000c1";
const JOB = "1c1c1c1c-0000-4000-8000-000000000001";

/** A hub holding `current` as the conversation's one Notify template, or none. */
function hubApi(
  current?: NotifyResponse,
  put: (body: NotifyBody) => Promise<{ version: number; revision: number }> = async () => ({ version: 1, revision: 0 })
) {
  return {
    listNotify: vi.fn(async () => ({
      notify_templates:
        current === undefined ? [] : [{ id: ITEM_ID, name: current.name, version: current.version, revision: current.revision, updated_by: current.by }]
    })),
    getNotifyById: vi.fn(async () => {
      if (current === undefined) {
        throw new ApiError(404, { error: "none" }, "GET", "/notify-templates");
      }
      return current;
    }),
    putNotifyById: vi.fn(async (_agentId: string, _id: string, body: NotifyBody) => await put(body)),
    createNotify: vi.fn(async (_agentId: string, body: NotifyBody) => ({ id: ITEM_ID, ...(await put(body)) }))
  };
}

const loaded = (overrides: Partial<NotifyResponse> = {}): NotifyResponse => ({
  version: 2,
  revision: 0,
  product: "pcs",
  template_id: TEMPLATE_ID.toLowerCase(),
  service_id: SERVICE,
  type: "email",
  name: "Claim received",
  subject: "Your claim ((ref))",
  body: "Dear ((name))",
  notify_version: 4,
  notify_subject: "Your claim ((ref))",
  notify_body: "Dear ((name))",
  notify_preview: "<p>Dear ((name))</p>",
  data: {},
  by: "agent",
  summary: null,
  updated_at: "2026-11-18T00:00:00.000Z",
  ...overrides
});

describe("productOf", () => {
  it("should find a product by id, and answer unknown_product for any other", () => {
    expect(productOf("pcs", { products: PRODUCTS }).vault).toBe("pcs-aat");
    expect(() => productOf("nope", { products: PRODUCTS })).toThrow(expect.objectContaining({ code: "unknown_product" }));
  });

  it("should list the package's own products when no others are given", () => {
    expect(notifyProducts().some((product) => product.id === "pcs")).toBe(true);
  });
});

describe("notifyFailure", () => {
  it.each([
    ["The Azure CLI (az) isn't installed or isn't on the PATH. Install it, then run `az login`.", "az_missing"],
    ["Your Azure CLI session has expired or you are not signed in: run `az login`, then try again.", "az_login"],
    ["Forbidden: you have no read access to secrets in the Key Vault pcs-aat.", "forbidden"],
    ["The Key Vault pcs-aat has no secret named gov-notify-key.", "secret_not_found"],
    ["The secret gov-notify-key in pcs-aat is empty.", "secret_not_found"],
    ["Couldn't reach the Key Vault pcs-aat: check the name and your network.", "keyvault_error"]
  ])("should answer %j as %s with the package's words", (message, code) => {
    const failure = notifyFailure(new KeyVaultError(message));
    expect(failure).toBeInstanceOf(PodJobError);
    expect(failure?.code).toBe(code);
    expect(failure?.detail).toBe(message);
  });

  it.each([
    [401, "notify_forbidden"],
    [403, "notify_forbidden"],
    [404, "not_found"],
    [500, "notify_error"]
  ])("should answer Notify's %i as %s", (status, code) => {
    expect(notifyFailure(new NotifyApiError(`GOV.UK Notify returned ${status}: x`, status))?.code).toBe(code);
  });

  it("should answer a key that is not a Notify key as bad_key, and an unreachable Notify as notify_error", () => {
    expect(notifyFailure(new Error("The secret isn't a GOV.UK Notify API key: it should end with a service ID and a secret, both UUIDs."))?.code).toBe(
      "bad_key"
    );
    expect(notifyFailure(new Error("Can't reach GOV.UK Notify at https://api: ECONNRESET"))?.code).toBe("notify_error");
  });

  it("should keep a PodJobError as it is, and answer undefined for anything else", () => {
    const own = new PodJobError("conflict", "x");
    expect(notifyFailure(own)).toBe(own);
    expect(notifyFailure(new Error("other"))).toBeUndefined();
    expect(notifyFailure("text")).toBeUndefined();
  });
});

describe("listNotifyTemplates", () => {
  it("should read the product's key from its vault and list emails, then texts, then letters, each by name", async () => {
    const { deps, readKey } = fakes({
      templates: [
        template({ id: "00000000-0000-4000-8000-000000000003", type: "letter", name: "A letter" }),
        template({ id: "00000000-0000-4000-8000-000000000002", type: "email", name: "Zed" }),
        template({ id: "00000000-0000-4000-8000-000000000001", type: "sms", name: "Text" }),
        template({ id: "00000000-0000-4000-8000-000000000004", type: "email", name: "Alpha" }),
        template({ id: "not-a-uuid", name: "Dropped" })
      ]
    });

    const listed = await listNotifyTemplates("pcs", deps);

    expect(readKey).toHaveBeenCalledWith("pcs-aat", "gov-notify-key");
    expect(listed.truncated).toBe(false);
    expect(listed.templates.map((each) => each.name)).toEqual(["Alpha", "Zed", "Text", "A letter"]);
  });

  it("should cut a list at 1000 and say so", async () => {
    const many = Array.from({ length: 1001 }, (_, at) => template({ id: `00000000-0000-4000-8000-${String(at).padStart(12, "0")}`, name: `T${at}` }));
    const { deps } = fakes({ templates: many });

    const listed = await listNotifyTemplates("pcs", deps);

    expect(listed.templates).toHaveLength(1000);
    expect(listed.truncated).toBe(true);
  });

  it("should give an untitled template a name and clip a long one", async () => {
    const { deps } = fakes({ templates: [template({ name: "  " }), template({ id: "00000000-0000-4000-8000-000000000009", name: "x".repeat(600) })] });

    const listed = await listNotifyTemplates("pcs", deps);

    expect(listed.templates.map((each) => each.name.length)).toEqual([8, 500]);
    expect(listed.templates[0]?.name).toBe("Untitled");
  });

  it("should clip a long name without leaving half of a surrogate pair", async () => {
    const { deps } = fakes({ templates: [template({ name: `${"x".repeat(498)}😀😀` })] });

    const [listed] = (await listNotifyTemplates("pcs", deps)).templates;

    expect(listed?.name).toBe(`${"x".repeat(498)}…`);
  });

  it("should answer a Key Vault failure with its code", async () => {
    const { deps } = fakes({
      read: async () => {
        throw new KeyVaultError("Forbidden: you have no read access to secrets in the Key Vault pcs-aat.");
      }
    });

    await expect(listNotifyTemplates("pcs", deps)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("should answer a Notify failure with its code", async () => {
    const { deps, client } = fakes();
    client.listTemplates.mockRejectedValue(new NotifyApiError("GOV.UK Notify returned 403: AuthError", 403));

    await expect(listNotifyTemplates("pcs", deps)).rejects.toMatchObject({ code: "notify_forbidden" });
  });

  it("should pass on a fault that is not Notify's", async () => {
    const { deps, client } = fakes();
    client.listTemplates.mockRejectedValue(new TypeError("boom"));

    await expect(listNotifyTemplates("pcs", deps)).rejects.toThrow("boom");
  });
});

describe("pullNotifyTemplate", () => {
  it("should load the template with Notify's preview of its placeholders as a new template when no target is named", async () => {
    const { deps, client } = fakes();
    const api = hubApi(undefined, async () => ({ version: 1, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 1, name: "Claim received", written: true });
    expect(client.previewTemplate).toHaveBeenCalledWith(TEMPLATE_ID, { ref: "((ref))", name: "((name))" }, undefined);
    expect(api.createNotify).toHaveBeenCalledWith("a1", {
      subject: "Your claim ((ref))",
      body: "Dear ((name))",
      data: {},
      base_version: 0,
      summary: "Loaded version 4 from Notify",
      source: {
        product: "pcs",
        template_id: TEMPLATE_ID.toLowerCase(),
        service_id: SERVICE,
        type: "email",
        name: "Claim received",
        notify_version: 4,
        notify_subject: "Your claim ((ref))",
        notify_body: "Dear ((name))",
        notify_preview: "<p>Dear ((name))</p>"
      }
    });
  });

  it("should put on the target's version, and keep a text message's preview as text with no subject", async () => {
    const { deps } = fakes({
      got: template({ type: "sms", subject: null, body: "Hi ((name))" }),
      preview: { id: TEMPLATE_ID, type: "sms", version: 4, body: "Hi ((name))", html: null }
    });
    const api = hubApi(loaded({ version: 5, template_id: "00000000-0000-4000-8000-000000000099" }), async () => ({ version: 6, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 6, name: "Claim received", written: true });
    expect(api.putNotifyById.mock.calls[0]?.[1]).toBe(ITEM_ID);
    expect(api.createNotify).not.toHaveBeenCalled();
    const body = api.putNotifyById.mock.calls[0]?.[2];
    expect(body?.base_version).toBe(5);
    expect(body?.subject).toBeNull();
    expect(body?.source?.notify_subject).toBeNull();
    expect(body?.source?.notify_preview).toBe("Hi ((name))");
  });

  it("should record a load from the panel's picker as the person's", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded({ by: "user" }), async () => ({ version: 3, revision: 0 }));

    const again = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps, by: "user" });
    const fresh = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps, by: "user" });

    expect(again.written).toBe(false);
    expect(fresh.written).toBe(true);
  });

  it("should send by: user only for a load from the panel's picker", async () => {
    const { deps } = fakes();
    const panel = hubApi();
    const session = hubApi();

    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: panel, deps, by: "user" });
    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: session, deps });

    expect(panel.createNotify.mock.calls[0]?.[1].by).toBe("user");
    expect(session.createNotify.mock.calls[0]?.[1]).not.toHaveProperty("by");
  });

  it("should keep no preview when Notify cannot be reached for it", async () => {
    const { deps } = fakes({ preview: new Error("Can't reach GOV.UK Notify: fetch failed") });
    const api = hubApi();

    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(api.createNotify.mock.calls[0]?.[1].source?.notify_preview).toBeNull();
  });

  it("should write nothing once the job is aborted", async () => {
    const { deps, client } = fakes();
    const job = new AbortController();
    client.previewTemplate.mockImplementation(async () => {
      job.abort();
      return { id: TEMPLATE_ID, type: "email", version: 4, body: "x", html: "<p>x</p>" } as never;
    });
    const api = hubApi();

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps, signal: job.signal })).rejects.toThrow();
    expect(api.createNotify).not.toHaveBeenCalled();
  });

  it("should stop every Notify call with the job's signal", async () => {
    const job = new AbortController();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => Promise.reject(new TypeError("fetch failed")));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const real: NotifyDeps = { products: PRODUCTS, readKey: async () => KEY };

      await expect(
        pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: real, signal: job.signal })
      ).rejects.toMatchObject({ code: "notify_error" });
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ signal: job.signal });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should give an email with no subject an empty one, and keep no preview Notify refused", async () => {
    const { deps } = fakes({ got: template({ subject: undefined }), preview: new NotifyApiError("GOV.UK Notify returned 400: x", 400) });
    const api = hubApi();

    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    const body = api.createNotify.mock.calls[0]?.[1];
    expect(body?.subject).toBe("");
    expect(body?.source?.notify_preview).toBeNull();
  });

  it("should keep no preview for an email whose preview has no HTML, or one too big to hold", async () => {
    const none = fakes({ preview: { id: TEMPLATE_ID, type: "email", version: 4, body: "x", html: null } });
    const big = fakes({ preview: { id: TEMPLATE_ID, type: "email", version: 4, body: "x", html: "x".repeat(MAX_PREVIEW_BYTES + 1) } });
    const first = hubApi();
    const second = hubApi();

    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: first, deps: none.deps });
    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: second, deps: big.deps });

    expect(first.createNotify.mock.calls[0]?.[1].source?.notify_preview).toBeNull();
    expect(second.createNotify.mock.calls[0]?.[1].source?.notify_preview).toBeNull();
  });

  it("should drop the preview rather than the template when the whole would pass the hub's request cap", async () => {
    const body = "é".repeat(MAX_BODY);
    const { deps } = fakes({ got: template({ body }), preview: { id: TEMPLATE_ID, type: "email", version: 4, body, html: "é".repeat(50_000) } });
    const api = hubApi();

    await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(api.createNotify.mock.calls[0]?.[1].source?.notify_preview).toBeNull();
  });

  it("should refuse a template too big for the hub with too_large", async () => {
    const tooLong = fakes({ got: template({ body: "x".repeat(MAX_BODY + 1) }) });
    const tooWide = fakes({ got: template({ body: "\u0001".repeat(MAX_BODY) }), preview: new NotifyApiError("no", 400) });

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: tooLong.deps })).rejects.toMatchObject({
      code: "too_large"
    });
    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: tooWide.deps })).rejects.toMatchObject({
      code: "too_large"
    });
  });

  it("should write nothing when the latest version is already this template at this Notify version, unchanged", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded());

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 2, name: "Claim received", written: false });
    expect(api.createNotify).not.toHaveBeenCalled();
    expect(api.putNotifyById).not.toHaveBeenCalled();
  });

  it("should write nothing when the target is already this template at this Notify version, unchanged", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded());

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 2, name: "Claim received", written: false });
    expect(api.putNotifyById).not.toHaveBeenCalled();
  });

  it("should load into the template that already holds it, and make no second, when no target is named and Notify's version moved on", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded({ notify_version: 3 }), async () => ({ version: 3, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 3, name: "Claim received", written: true });
    expect(api.putNotifyById).toHaveBeenCalledWith("a1", ITEM_ID, expect.objectContaining({ base_version: 2 }));
    expect(api.createNotify).not.toHaveBeenCalled();
  });

  it("should make a new template even though another holds it, when the load asks to create", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded(), async () => ({ version: 1, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps, create: true, jobId: JOB });

    expect(pulled.written).toBe(true);
    expect(api.createNotify).toHaveBeenCalledWith("a1", expect.objectContaining({ base_version: 0, summary: "Loaded version 4 from Notify (job 1c1c1c1c)" }));
  });

  it("should answer the template an earlier run of the same job made, and make no second, when a load that creates runs again", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded({ by: "user", summary: "Loaded version 4 from Notify (job 1c1c1c1c)" }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps, create: true, jobId: JOB });

    expect(pulled).toEqual({ id: ITEM_ID, version: 2, name: "Claim received", written: false });
    expect(api.createNotify).not.toHaveBeenCalled();
  });

  it("should make a new template when no template of the conversation holds this one and no target is named", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded({ template_id: "00000000-0000-4000-8000-000000000099" }), async () => ({ version: 1, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api, deps });

    expect(pulled.written).toBe(true);
    expect(api.getNotifyById).toHaveBeenCalledWith("a1", ITEM_ID);
    expect(api.createNotify.mock.calls[0]?.[1].base_version).toBe(0);
  });

  it("should answer conflict when the target is no longer in the chat", async () => {
    const { deps } = fakes();
    const api = hubApi();

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api, deps })).rejects.toMatchObject({
      code: "conflict"
    });
    expect(api.putNotifyById).not.toHaveBeenCalled();
  });

  it.each([
    ["the person has filled it in", { data: { name: "Ada" } }],
    ["the person wrote it", { by: "user" as const }],
    ["the draft has changed", { body: "Hello ((name))" }],
    ["Notify has a newer version", { notify_version: 3 }]
  ])("should load it again when %s", async (_label, change) => {
    const { deps } = fakes();
    const api = hubApi(loaded(change), async () => ({ version: 3, revision: 0 }));

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api, deps });

    expect(pulled.written).toBe(true);
  });

  it("should answer the version a repeated job already wrote when the put is refused as stale", async () => {
    const { deps } = fakes();
    const api = hubApi(loaded({ version: 0, notify_version: 3 }), async () => {
      throw new ApiError(409, { error: "changed", current: loaded({ version: 1 }) }, "PUT", "/notify");
    });

    const pulled = await pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api, deps });

    expect(pulled).toEqual({ id: ITEM_ID, version: 1, name: "Claim received", written: false });
  });

  it("should answer conflict when another version was written while it loaded", async () => {
    const { deps } = fakes();
    const stale = hubApi(loaded({ notify_version: 3 }), async () => {
      throw new ApiError(409, { error: "changed", current: loaded({ by: "user", body: "mine" }) }, "PUT", "/notify");
    });
    const empty = hubApi(loaded({ notify_version: 3 }), async () => {
      throw new ApiError(409, { error: "changed" }, "PUT", "/notify");
    });

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api: stale, deps })).rejects.toMatchObject({
      code: "conflict"
    });
    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", target: ITEM_ID, api: empty, deps })).rejects.toMatchObject({
      code: "conflict"
    });
  });

  it("should pass on any other refusal from the hub, and from the read before it", async () => {
    const { deps } = fakes();
    const refused = hubApi(undefined, async () => {
      throw new ApiError(400, { error: "bad" }, "PUT", "/notify");
    });
    const unreadable = { ...hubApi(), listNotify: vi.fn(async () => Promise.reject(new ApiError(500, { error: "down" }, "GET", "/notify-templates"))) };

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: refused, deps })).rejects.toMatchObject({ status: 400 });
    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: unreadable, deps })).rejects.toMatchObject({
      status: 500
    });
  });

  it("should refuse an id that is not a UUID before reading anything", async () => {
    const { deps, readKey } = fakes();

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: "nope", agentId: "a1", api: hubApi(), deps })).rejects.toMatchObject({ code: "not_found" });
    expect(readKey).not.toHaveBeenCalled();
  });

  it("should answer Notify's refusal to give the template with its code, and pass on an aborted preview", async () => {
    const missing = fakes();
    missing.client.getTemplate.mockRejectedValue(new NotifyApiError("GOV.UK Notify returned 404: NoResultFound", 404));
    const aborted = fakes({ preview: new DOMException("aborted", "AbortError") });
    const job = new AbortController();
    job.abort();

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: missing.deps })).rejects.toMatchObject({
      code: "not_found"
    });
    await expect(
      pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: aborted.deps, signal: job.signal })
    ).rejects.toThrow("aborted");
  });

  it("should answer a key that is not a Notify key with bad_key", async () => {
    const { deps } = fakes({ read: async () => "not a key" });
    const real: NotifyDeps = { products: deps.products, readKey: deps.readKey };

    await expect(pullNotifyTemplate({ productId: "pcs", templateId: TEMPLATE_ID, agentId: "a1", api: hubApi(), deps: real })).rejects.toMatchObject({
      code: "bad_key"
    });
  });
});
