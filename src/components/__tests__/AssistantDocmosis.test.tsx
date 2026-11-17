/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocmosisPanel, RENDER_AFTER_MS, SharedDocmosis } from "@/components/assistant/DocmosisPanel";
import type { DocmosisSummary, DocmosisVersionEntry, DocmosisView, JsonObject } from "@/components/assistant/docmosis-data";

vi.mock("@/components/assistant/docmosis-pdf", () => ({
  drawPdf: vi.fn(async () => {
    const canvas = document.createElement("canvas");
    canvas.setAttribute("data-testid", "page");
    return [canvas];
  })
}));

const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const SUMMARY: DocmosisSummary = { name: "claim-form", version: 3, revision: 0, updatedBy: "agent", pdf: "ready" };

function view(overrides: Partial<DocmosisView> = {}): DocmosisView {
  return {
    version: 3,
    revision: 0,
    name: "claim-form",
    docx: `sha256:${"a".repeat(64)}`,
    schema: {
      warnings: [],
      root: {
        kind: "object",
        controls: [],
        notes: [],
        properties: {
          claimant: {
            kind: "object",
            controls: [],
            notes: [],
            properties: {
              name: { kind: "string", controls: ["cs_hasClaimant"], notes: ["Shown in the header"] },
              represented: { kind: "boolean", controls: [], notes: [] }
            }
          },
          issued: { kind: "date", controls: [], notes: [], inputFormat: "dd/MM/yyyy" },
          hearing: { kind: "date", controls: [], notes: [], inputFormat: "d MMMM yyyy" },
          defendants: {
            kind: "array",
            controls: [],
            notes: [],
            item: { kind: "object", controls: [], notes: [], properties: { name: { kind: "string", controls: [], notes: [] } } }
          }
        }
      }
    },
    data: { claimant: { name: "Ann" }, defendants: [{ name: "Bob" }] },
    by: "agent",
    summary: "First draft",
    updated_at: "2026-11-03T09:00:00.000Z",
    has_pdf: true,
    render_error: null,
    ...overrides
  };
}

interface Rendering {
  body: { data: JsonObject; base_version: number; base_revision: number };
  answer: (status: number, body: unknown) => void;
}

/** A fetch that serves the template's reads and holds each render until the test answers it. */
function serve(latest: DocmosisView = view(), options: { versions?: DocmosisVersionEntry[]; older?: Record<number, DocmosisView> } = {}) {
  const renders: Rendering[] = [];
  const reads: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return await new Promise<Response>((resolve) => {
        renders.push({
          body: JSON.parse(String(init.body)),
          answer: (status, body) => resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }))
        });
      });
    }
    reads.push(url);
    if (url.endsWith("/versions")) {
      return new Response(
        JSON.stringify({ versions: options.versions ?? [{ version: 3, by: "agent", summary: "First draft", updated_at: "", has_pdf: true }] })
      );
    }
    const older = /\/versions\/(\d+)$/.exec(url);
    if (older !== null && options.older?.[Number(older[1])] !== undefined) {
      return new Response(JSON.stringify(options.older[Number(older[1])]));
    }
    if (url.endsWith("/pdf")) {
      return new Response(new Uint8Array([37, 80, 68, 70]));
    }
    return new Response(JSON.stringify(latest));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { renders, reads, fetchMock };
}

async function open(props: Partial<React.ComponentProps<typeof DocmosisPanel>> = {}) {
  render(
    <DocmosisPanel conversationId={CONVERSATION} docmosis={SUMMARY} owner onClose={() => undefined} narrow={false} announce={() => undefined} {...props} />
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("DocmosisPanel form", () => {
  it("should generate fieldsets, fields and repeat rows from the schema", async () => {
    serve();
    await open();
    const claimant = screen.getByRole("group", { name: "claimant" });
    expect(within(claimant).getByLabelText("name")).toHaveProperty("value", "Ann");
    expect(within(claimant).getByLabelText("represented")).toHaveProperty("checked", false);
    const row = screen.getByRole("group", { name: "defendants 1" });
    expect(within(row).getByLabelText("name")).toHaveProperty("value", "Bob");
    expect(screen.getByRole("button", { name: "Add defendants row" })).toBeTruthy();
  });

  it("should show which blocks a value controls, and the template's notes on it", async () => {
    serve();
    await open();
    expect(screen.getByText("cs_hasClaimant").tagName).toBe("CODE");
    expect(screen.getByText("Shown in the header")).toBeTruthy();
  });

  it("should use a date input for a date format a date input can hold, and text with the format as its hint for any other", async () => {
    serve(view({ data: { issued: "03/11/2026", hearing: "3 November 2026" } }));
    await open();
    const issued = screen.getByLabelText(/^issued/) as HTMLInputElement;
    expect(issued.type).toBe("date");
    expect(issued.value).toBe("2026-11-03");
    const hearing = screen.getByLabelText(/^hearing/) as HTMLInputElement;
    expect(hearing.type).toBe("text");
    expect(hearing.placeholder).toBe("d MMMM yyyy");
  });

  it("should store a picked date in the template's own format", async () => {
    const { renders } = serve(view({ data: {} }));
    await open();
    fireEvent.change(screen.getByLabelText(/^issued/), { target: { value: "2026-11-03" } });
    await wait(RENDER_AFTER_MS);
    expect(renders[0]?.body.data).toEqual({ issued: "03/11/2026" });
  });

  it("should add and remove repeat rows", async () => {
    const { renders } = serve();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Add defendants row" }));
    expect(screen.getByRole("group", { name: "defendants 2" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove defendants 1" }));
    await wait(RENDER_AFTER_MS);
    expect(renders[0]?.body.data.defendants).toEqual([{}]);
  });

  it("should show a form with nothing to edit, and no way to render, to a reader", async () => {
    const { fetchMock } = serve();
    await open({ owner: false });
    expect((within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByLabelText("represented")).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^Add / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    await wait(RENDER_AFTER_MS * 2);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("DocmosisPanel rendering", () => {
  it("should render once, with the version it was edited from, after the person stops typing for 800 ms", async () => {
    const { renders } = serve();
    await open();
    const name = within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name");
    fireEvent.change(name, { target: { value: "Anna" } });
    await wait(RENDER_AFTER_MS - 1);
    fireEvent.change(name, { target: { value: "Annabel" } });
    await wait(RENDER_AFTER_MS - 1);
    expect(renders).toHaveLength(0);
    await wait(1);
    expect(renders).toHaveLength(1);
    expect(renders[0]?.body).toEqual({
      data: { claimant: { name: "Annabel" }, defendants: [{ name: "Bob" }] },
      base_version: 3,
      base_revision: 0
    });
  });

  it("should send one request at a time, and once more after it returns when the form changed meanwhile", async () => {
    const { renders } = serve();
    await open();
    const name = within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name");
    fireEvent.change(name, { target: { value: "A" } });
    await wait(RENDER_AFTER_MS);
    expect(renders).toHaveLength(1);
    fireEvent.change(name, { target: { value: "AB" } });
    await wait(RENDER_AFTER_MS * 2);
    expect(renders).toHaveLength(1);
    await act(async () => renders[0]?.answer(200, { version: 4, revision: 1, status: "rendered" }));
    await wait(0);
    expect(renders).toHaveLength(2);
    expect(renders[1]?.body.data.claimant).toEqual({ name: "AB" });
    expect(renders[1]?.body.base_version).toBe(4);
    expect(renders[1]?.body.base_revision).toBe(1);
  });

  it("should drop the answer to a render the person has typed past", async () => {
    const { renders, reads } = serve();
    await open();
    const pdfReads = () => reads.filter((url) => url.endsWith("/pdf")).length;
    const before = pdfReads();
    const name = within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name");
    fireEvent.change(name, { target: { value: "A" } });
    await wait(RENDER_AFTER_MS);
    fireEvent.change(name, { target: { value: "AB" } });
    await act(async () => renders[0]?.answer(200, { version: 4, revision: 1, status: "failed", error: { short: "Stale failure", long: "" } }));
    await wait(0);
    expect(screen.queryByText("Stale failure")).toBeNull();
    expect(pdfReads()).toBe(before);
  });

  it("should show the short merge error, with the long one behind a disclosure", async () => {
    const { renders } = serve();
    await open();
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    await wait(RENDER_AFTER_MS);
    await act(async () =>
      renders[0]?.answer(200, { version: 4, revision: 1, status: "failed", error: { short: "Bad conditional", long: "line 4: cs_x unclosed" } })
    );
    expect(screen.getByText("Bad conditional")).toBeTruthy();
    const details = screen.getByText("line 4: cs_x unclosed").closest("details");
    expect(details?.open).toBe(false);
  });

  it("should not render a date the template is certain to reject", async () => {
    const { renders } = serve(view({ data: {} }));
    await open();
    fireEvent.change(screen.getByLabelText(/^hearing/), { target: { value: "soon" } });
    await wait(RENDER_AFTER_MS * 2);
    expect(renders).toHaveLength(0);
    expect(screen.getByText(/isn't a date written as d MMMM yyyy/)).toBeTruthy();
  });

  it("should wait the time the renderer asks for when it is busy, then send again", async () => {
    const { renders } = serve();
    await open();
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    await wait(RENDER_AFTER_MS);
    await act(async () => renders[0]?.answer(503, { error: "busy", retry_after: 7 }));
    await wait(6999);
    expect(renders).toHaveLength(1);
    await wait(1);
    expect(renders).toHaveLength(2);
  });

  it("should offer the newer version against what the person typed when the render is refused as a conflict, and keep their values on request", async () => {
    const { renders } = serve();
    await open();
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Mine" } });
    await wait(RENDER_AFTER_MS);
    const current = view({ version: 4, data: { claimant: { name: "Theirs" } } });
    await act(async () => renders[0]?.answer(409, { error: "moved on", current }));
    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed this template.");
    expect((within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement).value).toBe("Mine");
    fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
    await wait(0);
    expect(renders).toHaveLength(2);
    expect(renders[1]?.body.base_version).toBe(4);
    expect(renders[1]?.body.data.claimant).toEqual({ name: "Mine" });
  });

  it("should keep what was typed during a busy wait as unsaved, and offer a conflict when an agent version arrives", async () => {
    const served = serve();
    const props = { conversationId: CONVERSATION, owner: true, onClose: () => undefined, narrow: false, announce: () => undefined };
    const { rerender } = render(<DocmosisPanel {...props} docmosis={SUMMARY} />);
    await wait(0);
    const name = () => within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement;
    fireEvent.change(name(), { target: { value: "Sent" } });
    await wait(RENDER_AFTER_MS);
    fireEvent.change(name(), { target: { value: "Typed later" } });
    await act(async () => served.renders[0]?.answer(503, { error: "busy", retry_after: 30, version: 4, revision: 1 }));
    const base = served.fetchMock.getMockImplementation();
    const agent = view({ version: 5, data: { claimant: { name: "Agent" } } });
    served.fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method !== "POST" && url.endsWith(`/docmosis/${CONVERSATION}`) ? new Response(JSON.stringify(agent)) : (base?.(url, init) as Promise<Response>)
    );
    rerender(<DocmosisPanel {...props} docmosis={{ ...SUMMARY, version: 5 }} />);
    await wait(0);
    expect(screen.getByRole("alert").textContent).toContain("The assistant has changed this template.");
    expect(name().value).toBe("Typed later");
  });
});

const mainReads = (reads: string[]) => reads.filter((url) => url.endsWith(`/docmosis/${CONVERSATION}`)).length;

describe("DocmosisPanel reading", () => {
  it("should read the template again when the page says its pdf has changed, and not poll for it", async () => {
    const { reads } = serve(view({ has_pdf: false }));
    const props = { conversationId: CONVERSATION, owner: true, onClose: () => undefined, narrow: false, announce: () => undefined };
    const { rerender } = render(<DocmosisPanel {...props} docmosis={{ ...SUMMARY, pdf: "pending" }} />);
    await wait(0);
    expect(mainReads(reads)).toBe(1);
    expect(screen.getByText("Waiting for the assistant's PDF…")).toBeTruthy();
    await wait(60_000);
    expect(mainReads(reads)).toBe(1);
    rerender(<DocmosisPanel {...props} docmosis={{ ...SUMMARY, pdf: "ready" }} />);
    await wait(0);
    expect(mainReads(reads)).toBe(2);
  });

  it("should offer the kept versions, read the one picked as read-only, and go back to the latest", async () => {
    const earlier = view({ version: 2, data: { claimant: { name: "Old" } }, by: "user", has_pdf: false });
    const { reads } = serve(view(), {
      versions: [
        { version: 3, by: "agent", summary: "First draft", updated_at: "", has_pdf: true },
        { version: 2, by: "user", summary: null, updated_at: "", has_pdf: false }
      ],
      older: { 2: earlier }
    });
    await open();
    expect(screen.getByRole("option", { name: "Version 2, by you" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2" } });
    await wait(0);
    expect(reads.some((url) => url.endsWith("/versions/2"))).toBe(true);
    expect(screen.getByText("Version 2 is not the latest, so it can't be edited.")).toBeTruthy();
    const name = within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement;
    expect(name.value).toBe("Old");
    expect(name.readOnly).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to the latest" }));
    await wait(0);
    expect((within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement).value).toBe("Ann");
  });

  it("should say so when a version cannot be read", async () => {
    const { fetchMock } = serve(view(), {
      versions: [
        { version: 3, by: "agent", summary: null, updated_at: "", has_pdf: true },
        { version: 2, by: "agent", summary: null, updated_at: "", has_pdf: true }
      ]
    });
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/versions/2") ? new Response("no", { status: 500 }) : (base?.(url, init) as Promise<Response>)
    );
    await open();
    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "2" } });
    await wait(0);
    expect(screen.getByText("Couldn't load version 2.")).toBeTruthy();
  });

  it("should offer to try again when the template cannot be read", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await open();
    expect(screen.getByText("Could not load the template.")).toBeTruthy();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(0);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("should offer the PDF and the data as downloads", async () => {
    serve();
    const create = vi.fn(() => "blob:data");
    const revoke = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await open();
    const pdf = screen.getByRole("link", { name: /Download PDF/ }) as HTMLAnchorElement;
    expect(pdf.getAttribute("href")).toBe(`/api/ui/assistant/docmosis/${CONVERSATION}/versions/3/pdf`);
    expect(pdf.getAttribute("download")).toBe("claim-form-v3.pdf");
    fireEvent.click(screen.getByRole("button", { name: /Download data.json/ }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:data");
    click.mockRestore();
  });

  it("should say the preview could not be shown, and try again", async () => {
    const { fetchMock } = serve();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      url.endsWith("/pdf") ? new Response("no", { status: 500 }) : (base?.(url, init) as Promise<Response>)
    );
    await open();
    expect(screen.getByText(/Could not show the preview/)).toBeTruthy();
    fetchMock.mockImplementation(base as never);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(0);
    expect(screen.queryByText(/Could not show the preview/)).toBeNull();
  });
});

describe("DocmosisPanel render refusals", () => {
  async function edit() {
    const served = serve();
    const closed = vi.fn();
    await open({ onClose: closed });
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    await wait(RENDER_AFTER_MS);
    return { ...served, closed };
  }

  it("should prefer the retry-after header to the body", async () => {
    const served = serve();
    const fetchMock = served.fetchMock;
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === "POST" ? new Response("{}", { status: 503, headers: { "retry-after": "3" } }) : (base?.(url, init) as Promise<Response>)
    );
    await open();
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    await wait(RENDER_AFTER_MS);
    expect(screen.getByText("The renderer is busy, trying again in 3s")).toBeTruthy();
  });

  it("should take a newer base from a superseded answer, and leave the phase and the pdf to the newer render", async () => {
    const { renders, reads } = await edit();
    const pdfReads = () => reads.filter((url) => url.endsWith("/pdf")).length;
    const before = pdfReads();
    await act(async () => renders[0]?.answer(200, { version: 6, revision: 2, status: "superseded" }));
    await wait(0);
    expect(pdfReads()).toBe(before);
    expect(screen.queryByText("The renderer could not be reached.")).toBeNull();
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "ZZ" } });
    await wait(RENDER_AFTER_MS);
    expect(renders[1]?.body.base_version).toBe(6);
    expect(renders[1]?.body.base_revision).toBe(2);
  });

  it("should not move the base back for a superseded answer older than it", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(200, { version: 1, revision: 0, status: "superseded" }));
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "ZZ" } });
    await wait(RENDER_AFTER_MS);
    expect(renders[1]?.body.base_version).toBe(3);
  });

  it("should reject any other 4xx, a 429 included, and not mark the data saved", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(429, { error: "slow down", version: 4, revision: 2 }));
    expect(screen.getByRole("alert").textContent).toContain("turned the request down (status 429)");
  });

  it("should say the renderer could not be reached on a 502, adopt the version it names, and send again on request", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(502, { error: "bad gateway", version: 4, revision: 3 }));
    expect(screen.getByText("The renderer could not be reached.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait(0);
    expect(renders).toHaveLength(2);
    expect(renders[1]?.body.base_version).toBe(4);
    expect(renders[1]?.body.base_revision).toBe(3);
  });

  it("should say the request was turned down, not that the renderer is unreachable, on any other 4xx", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(422, { error: "no" }));
    expect(screen.getByRole("alert").textContent).toContain("turned the request down (status 422)");
    expect(screen.queryByText("The renderer could not be reached.")).toBeNull();
  });

  it("should treat an answer it cannot read as the renderer being unreachable", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(200, "not json {" as never));
    expect(screen.getByText("The renderer could not be reached.")).toBeTruthy();
  });

  it("should treat a 409 that carries no current version as the renderer being unreachable", async () => {
    const { renders } = await edit();
    await act(async () => renders[0]?.answer(409, { error: "moved" }));
    expect(screen.getByText("The renderer could not be reached.")).toBeTruthy();
  });
});

describe("DocmosisPanel closing", () => {
  it("should close at once when nothing is waiting to be saved", async () => {
    serve();
    const confirm = vi.spyOn(window, "confirm");
    const onClose = vi.fn();
    await open({ onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close template" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("should ask first, and stay open, while edits are not yet saved", async () => {
    const { fetchMock } = serve();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const onClose = vi.fn();
    await open({ onClose });
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    fireEvent.click(screen.getByRole("button", { name: "Close template" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Your changes are still being saved"));
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close template" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => init?.keepalive === true)).toBe(false);
    confirm.mockRestore();
  });

  it("should tell the chat when edits are waiting and when they are not", async () => {
    const { renders } = serve();
    const onBusy = vi.fn();
    await open({ onBusy });
    fireEvent.change(within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name"), { target: { value: "Z" } });
    expect(onBusy).toHaveBeenLastCalledWith(true);
    await wait(RENDER_AFTER_MS);
    await act(async () => renders[0]?.answer(200, { version: 4, revision: 1, status: "rendered" }));
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });
});

describe("SharedDocmosis", () => {
  it("should show the template read-only, with nothing to close and nothing sent", async () => {
    const { fetchMock } = serve();
    render(<SharedDocmosis conversationId={CONVERSATION} docmosis={SUMMARY} />);
    await wait(RENDER_AFTER_MS * 2);
    expect((within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Close template" })).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });
});

describe("DocmosisForm accessibility and bad dates", () => {
  it("should show a date that does not match its format as written, with the problem, rather than a blank date input", async () => {
    serve(view({ data: { issued: "3rd of November" } }));
    await open();
    const issued = screen.getByLabelText(/^issued/) as HTMLInputElement;
    expect(issued.type).toBe("text");
    expect(issued.value).toBe("3rd of November");
    expect(screen.getAllByText(/isn't a date written as dd\/MM\/yyyy/).length).toBeGreaterThan(0);
  });

  it("should tie a field's error, date format, controls and notes to its input", async () => {
    serve(view({ data: { issued: "soon", claimant: { name: "Ann" } } }));
    await open();
    const described = (input: HTMLElement) =>
      (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" | ");
    const name = within(screen.getByRole("group", { name: "claimant" })).getByLabelText("name");
    expect(described(name)).toContain("cs_hasClaimant");
    expect(described(name)).toContain("Shown in the header");
    const issued = screen.getByLabelText(/^issued/);
    expect(described(issued)).toContain("date, stored as dd/MM/yyyy");
    expect(described(issued)).toContain("isn't a date");
  });
});
