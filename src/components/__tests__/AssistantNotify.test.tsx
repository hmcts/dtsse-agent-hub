/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotifyPanel, SAVE_AFTER_MS, SharedNotify, WAKING_RETRY_MS } from "@/components/assistant/NotifyPanel";
import type { ListedTemplate, NotifySummary, NotifyVersionEntry, NotifyView } from "@/components/assistant/notify-data";

const CONVERSATION = "33333333-3333-3333-3333-333333333333";
const TEMPLATE = "ab1f3d4a-0000-4000-8000-000000000002";
const SERVICE = "5c1f3d4a-0000-4000-8000-000000000001";
const SUMMARY: NotifySummary = { name: "Claim received", version: 2, revision: 0, updatedBy: "agent" };

function view(overrides: Partial<NotifyView> = {}): NotifyView {
  return {
    version: 2,
    revision: 0,
    product: "pcs",
    template_id: TEMPLATE,
    service_id: SERVICE,
    type: "email",
    name: "Claim received",
    subject: "Claim ((ref))",
    body: "Dear ((name))",
    notify_version: 4,
    notify_subject: "Claim ((ref))",
    notify_body: "Dear ((name))",
    notify_preview: "<p>Dear <span>((name))</span></p><script>alert(1)</script>",
    data: {},
    by: "agent",
    summary: "Loaded version 4 from Notify",
    updated_at: "2026-11-18T09:00:00.000Z",
    ...overrides
  };
}

const LISTED: ListedTemplate[] = [
  { id: "00000000-0000-4000-8000-000000000009", name: "Hearing reminder", type: "sms", version: 1 },
  { id: TEMPLATE, name: "Claim received", type: "email", version: 4 }
];

type JobAnswer = Record<string, unknown>;

interface Saving {
  body: { subject: string | null; body: string; data: Record<string, unknown>; base_version: number; base_revision: number };
  answer: (status: number, body: unknown) => void;
}

/**
 * A fetch serving the template's reads, holding each save until the test answers it, and running pod jobs: each ask
 * for a kind takes the next answer from `asks[kind]` (`{status: "pending"}` gets a job id), and reading the job back
 * answers `jobs[kind]`.
 */
function serve({
  latest = view() as NotifyView | null,
  versions = [
    { version: 2, by: "agent", name: "Claim received", notify_version: 4, summary: "Loaded version 4 from Notify", updated_at: "" }
  ] as NotifyVersionEntry[],
  older = {} as Record<number, NotifyView>,
  asks = {} as Record<string, JobAnswer[]>,
  jobs = {} as Record<string, JobAnswer>
} = {}) {
  const saves: Saving[] = [];
  const podJobs: { kind: string; args: Record<string, unknown> }[] = [];
  const state = { latest };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/ui/assistant/pod-jobs/")) {
      const job = /\/pod-jobs\/[^/]+\/(job-[a-z.]+)$/.exec(url);
      if (job !== null) {
        const kind = (job[1] as string).slice(4);
        return new Response(JSON.stringify({ job_id: job[1], kind, ...(jobs[kind] ?? { status: "pending" }) }));
      }
      const asked = JSON.parse(String(init?.body)) as { kind: string; args: Record<string, unknown> };
      podJobs.push(asked);
      const answer = asks[asked.kind]?.shift() ?? { status: "pending" };
      if (typeof answer.http === "number") {
        return new Response(JSON.stringify({ error: answer.error }), { status: answer.http });
      }
      return new Response(JSON.stringify(answer.status === "pending" ? { status: "pending", job_id: `job-${asked.kind}` } : answer));
    }
    if (init?.method === "POST") {
      return await new Promise<Response>((resolve) => {
        saves.push({ body: JSON.parse(String(init.body)), answer: (status, body) => resolve(new Response(JSON.stringify(body), { status })) });
      });
    }
    if (url.endsWith("/versions")) {
      return new Response(JSON.stringify({ versions }));
    }
    const asked = /\/versions\/(\d+)$/.exec(url);
    if (asked !== null) {
      const found = older[Number(asked[1])];
      return found === undefined ? new Response("{}", { status: 404 }) : new Response(JSON.stringify(found));
    }
    return state.latest === null ? new Response(JSON.stringify({ error: "none" }), { status: 404 }) : new Response(JSON.stringify(state.latest));
  });
  vi.stubGlobal("fetch", fetchMock);
  return { saves, podJobs, state, fetchMock };
}

async function wait(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function open(props: Partial<React.ComponentProps<typeof NotifyPanel>> = {}) {
  const announce = vi.fn();
  const result = render(
    <NotifyPanel conversationId={CONVERSATION} notify={SUMMARY} owner onClose={() => undefined} narrow={false} announce={announce} {...props} />
  );
  await wait();
  return { announce, ...result };
}

const srcdoc = (title: string): string => screen.getByTitle(title).getAttribute("srcdoc") ?? "";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NotifyPanel preview", () => {
  it("should show Notify's own preview, cleaned, in a sandboxed frame, while the draft is Notify's text with nothing filled in", async () => {
    serve();
    await open();

    expect(screen.getByText("Notify's own preview.")).toBeTruthy();
    expect(screen.getByTitle("Notify's preview").getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
    expect(srcdoc("Notify's preview")).toContain("((name))");
    expect(srcdoc("Notify's preview")).not.toContain("<script");
    expect(screen.getByText("Claim ((ref))")).toBeTruthy();
  });

  it("should preview locally, marked approximate, once the personalisation is filled in", async () => {
    serve();
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });

    expect(screen.getByText("Approximate: Notify's own preview is authoritative.")).toBeTruthy();
    expect(srcdoc("Approximate preview")).toContain("Ada");
  });

  it("should preview a text message as text, with its length in text messages", async () => {
    serve({ latest: view({ type: "sms", subject: null, notify_subject: null, body: "Hi ((name))", notify_body: "Hi ((name))", notify_preview: null }) });
    await open();

    expect(screen.getByText("Approximate: Notify's own preview is authoritative.")).toBeTruthy();
    expect(screen.getByText("Hi ((name))", { selector: "pre" })).toBeTruthy();
    expect(screen.getByText(/11 characters, 1 text message/)).toBeTruthy();
  });

  it("should show Notify's text preview of a letter as it is", async () => {
    serve({ latest: view({ type: "letter", notify_preview: "Dear ((name))" }) });
    await open();

    expect(screen.getByText("Notify's own preview.")).toBeTruthy();
    expect(screen.getByText("Dear ((name))", { selector: "pre" })).toBeTruthy();
  });

  it("should name the template, its product, type and Notify version, and link to it in Notify", async () => {
    serve();
    await open();

    expect(screen.getByRole("heading", { name: "Claim received" })).toBeTruthy();
    expect(screen.getByText("PCS · Email · Notify version 4")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open in Notify" });
    expect(link.getAttribute("href")).toBe(`https://www.notifications.service.gov.uk/services/${SERVICE}/templates/${TEMPLATE}`);
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("NotifyPanel saving", () => {
  it("should save the personalisation once typing stops, under the key Notify matches", async () => {
    const { saves } = serve({ latest: view({ data: { Name: "Old" } }) });
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS - 1);
    expect(saves).toHaveLength(0);
    expect(screen.getByText("Changes not yet saved")).toBeTruthy();
    await wait(1);

    expect(saves[0]?.body).toEqual({ subject: "Claim ((ref))", body: "Dear ((name))", data: { Name: "Ada" }, base_version: 2, base_revision: 0 });
    expect(screen.getByText("Saving…")).toBeTruthy();
    await act(async () => saves[0]?.answer(200, { version: 3, revision: 0, amended: false }));
    await wait();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("should remove a value the person clears", async () => {
    const { saves } = serve({ latest: view({ data: { name: "Ada" } }) });
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "" } });
    await wait(SAVE_AFTER_MS);

    expect(saves[0]?.body.data).toEqual({});
  });

  it("should send what was typed during a save once it returns, on the base it answered", async () => {
    const { saves } = serve();
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "A" } });
    await wait(SAVE_AFTER_MS);
    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS);
    expect(saves).toHaveLength(1);
    await act(async () => saves[0]?.answer(200, { version: 3, revision: 0, amended: false }));
    await wait();

    expect(saves[1]?.body).toMatchObject({ data: { name: "Ada" }, base_version: 3, base_revision: 0 });
  });

  it("should offer the newer version or the person's own when a save finds the template changed", async () => {
    const { saves } = serve();
    const { announce } = await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS);
    await act(async () => saves[0]?.answer(409, { error: "changed", current: view({ version: 3, by: "user", body: "Theirs ((name))" }) }));
    await wait();

    expect(screen.getByRole("alert").textContent).toMatch(/This Notify template was changed somewhere else/);
    expect(announce).toHaveBeenCalledWith("The Notify template changed while you were editing it");
    fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
    await wait();
    expect(saves[1]?.body).toMatchObject({ data: { name: "Ada" }, base_version: 3 });
  });

  it("should take the newer version when the person asks for it", async () => {
    const { saves } = serve();
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS);
    await act(async () => saves[0]?.answer(409, { error: "changed", current: view({ version: 3, data: { name: "Bea" } }) }));
    await wait();
    fireEvent.click(screen.getByRole("button", { name: "Use the newer version" }));

    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("Bea");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("should take the template as it is when the save it conflicted with already matches", async () => {
    const { saves } = serve();
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS);
    await act(async () => saves[0]?.answer(409, { error: "changed", current: view({ version: 3, data: { name: "Ada" } }) }));
    await wait();

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("should offer a retry when a save fails, and say so when the hub refuses it", async () => {
    const { saves } = serve();
    await open();

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    await wait(SAVE_AFTER_MS);
    await act(async () => saves[0]?.answer(500, { error: "internal error" }));
    await wait();
    expect(screen.getByRole("alert").textContent).toMatch(/Your changes could not be saved/);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait();
    await act(async () => saves[1]?.answer(400, { error: "body too long" }));
    await wait();

    expect(screen.getByRole("alert").textContent).toMatch(/turned your changes down/);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("should take in a newer version the assistant wrote while the person has nothing unsaved", async () => {
    const { state } = serve();
    const { rerender, announce } = await open();

    state.latest = view({ version: 3, body: "Hello ((name))", notify_body: "Hello ((name))", notify_preview: "<p>Hello</p>" });
    rerender(
      <NotifyPanel conversationId={CONVERSATION} notify={{ ...SUMMARY, version: 3 }} owner onClose={() => undefined} narrow={false} announce={announce} />
    );
    await wait();

    expect(srcdoc("Notify's preview")).toContain("Hello");
    expect(announce).toHaveBeenCalledWith("The assistant updated the Notify template");
  });

  it("should ask before closing on changes not yet saved", async () => {
    serve();
    const onClose = vi.fn();
    await open({ onClose });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Close Notify template" }));
    expect(confirm).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Notify template" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("NotifyPanel edit mode", () => {
  it("should edit the subject and body, diff them against Notify's text, revert, and save", async () => {
    const { saves } = serve();
    await open();

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Dear ((name))\nWe have it." } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Your claim ((ref))" } });

    const body = screen.getByText(/^Body, changed from Notify version 4/).closest("figure") as HTMLElement;
    expect(within(body).getByText("Added:", { exact: false }).parentElement?.textContent).toMatch(/We have it\./);
    expect(screen.getByText(/^Subject, changed from Notify version 4/)).toBeTruthy();
    expect(screen.getByText("Approximate: Notify's own preview is authoritative.")).toBeTruthy();
    await wait(SAVE_AFTER_MS);
    expect(saves[0]?.body).toMatchObject({ subject: "Your claim ((ref))", body: "Dear ((name))\nWe have it." });

    fireEvent.click(screen.getByRole("button", { name: "Revert to Notify's text" }));
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toBe("Dear ((name))");
    expect(screen.queryByText(/changed from Notify version 4/)).toBeNull();
  });

  it("should copy the subject and the body", async () => {
    serve();
    const { announce } = await open();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy subject" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy body" }));
    await wait();

    expect(writeText).toHaveBeenNthCalledWith(1, "Claim ((ref))");
    expect(writeText).toHaveBeenNthCalledWith(2, "Dear ((name))");
    expect(announce).toHaveBeenCalledWith("Copied the body");
    writeText.mockRejectedValue(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy body" }));
    await wait();
    expect(announce).toHaveBeenCalledWith("Could not copy the body");
  });

  it("should give a text message a message box and no subject", async () => {
    serve({ latest: view({ type: "sms", subject: null, notify_subject: null, notify_preview: "Dear ((name))" }) });
    await open();

    fireEvent.click(screen.getByRole("tab", { name: "Edit" }));

    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByLabelText("Subject")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy subject" })).toBeNull();
  });
});

describe("NotifyPanel picker", () => {
  it("should list a product's templates by type through the pod, and load the one picked", async () => {
    const { podJobs, state } = serve({
      latest: null,
      jobs: { "notify.list": { status: "done", result: { templates: LISTED, truncated: false } }, "notify.pull": { status: "done", result: { version: 1 } } }
    });
    const { announce } = await open({ notify: null });
    expect(screen.getByText("Choose a product and one of its templates to work on it here.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();
    expect(podJobs[0]).toEqual({ kind: "notify.list", args: { product: "pcs" } });
    const picker = screen.getByLabelText("Template") as HTMLSelectElement;
    expect(Array.from(picker.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(["Emails", "Text messages"]);

    state.latest = view({ version: 1 });
    fireEvent.change(picker, { target: { value: TEMPLATE } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await wait();

    expect(podJobs[1]).toEqual({ kind: "notify.pull", args: { product: "pcs", template_id: TEMPLATE } });
    expect(announce).toHaveBeenCalledWith("The Notify template is loaded");
    expect(screen.getByRole("heading", { name: "Claim received" })).toBeTruthy();
  });

  it("should ask a waking pod again until it takes the job", async () => {
    const { podJobs } = serve({
      latest: null,
      asks: { "notify.list": [{ status: "waking" }, { status: "waking" }] },
      jobs: { "notify.list": { status: "done", result: { templates: LISTED, truncated: true } } }
    });
    await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();
    expect(podJobs).toHaveLength(1);
    await wait(WAKING_RETRY_MS);
    await wait(WAKING_RETRY_MS);

    expect(podJobs).toHaveLength(3);
    expect(screen.getByText("Only the first 2 templates are listed.")).toBeTruthy();
  });

  it("should give up on a pod that stays waking, and offer to try again", async () => {
    serve({ latest: null, asks: { "notify.list": Array.from({ length: 30 }, () => ({ status: "waking" })) } });
    await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    for (let at = 0; at < 20; at += 1) {
      await wait(WAKING_RETRY_MS);
    }

    expect(screen.getByRole("alert").textContent).toMatch(/still starting/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should show the pod's own words when the list fails, and list again on Try again", async () => {
    const { podJobs } = serve({
      latest: null,
      jobs: { "notify.list": { status: "failed", error: "forbidden", detail: "Forbidden: you have no read access to secrets in the Key Vault pcs-aat." } }
    });
    await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();
    expect(screen.getByRole("alert").textContent).toMatch(/^Forbidden: you have no read access to secrets in the Key Vault pcs-aat\./);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait();

    expect(podJobs).toHaveLength(2);
  });

  it.each([
    ["unsupported", { status: "unsupported" }, /cannot read Notify yet\. Restart it/],
    ["no_pod", { status: "no_pod" }, /runs on your own computer/],
    ["assistant_gone", { status: "assistant_gone" }, /assistant has been replaced/],
    ["a refusal", { http: 429, error: "too many requests" }, /too many requests/],
    ["a busy pod", { status: "pending" }, /busy with others of these/]
  ])("should say why when the pod answers %s", async (_label, answer, message) => {
    serve({
      latest: null,
      asks: { "notify.list": [answer] },
      jobs: {
        "notify.list": { status: "failed", error: "failed", detail: "Your assistant is busy with others of these. Wait for them to finish, then try again." }
      }
    });
    await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();

    expect(screen.getByRole("alert").textContent).toMatch(message);
  });

  it("should say so when the hub cannot be reached at all", async () => {
    serve({ latest: null });
    await open({ notify: null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();

    expect(screen.getByRole("alert").textContent).toMatch(/could not be reached/);
  });

  it("should show a failed load in the pod's words and offer it again", async () => {
    const { podJobs } = serve({
      latest: null,
      jobs: {
        "notify.list": { status: "done", result: { templates: LISTED, truncated: false } },
        "notify.pull": { status: "failed", error: "notify_forbidden", detail: "GOV.UK Notify returned 403: AuthError" }
      }
    });
    const { announce } = await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: TEMPLATE } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await wait();

    expect(screen.getByRole("alert").textContent).toMatch(/^GOV\.UK Notify returned 403: AuthError/);
    expect(announce).toHaveBeenCalledWith("The Notify template could not be loaded");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait();
    expect(podJobs.filter((job) => job.kind === "notify.pull")).toHaveLength(2);
  });

  it("should set unsaved changes aside, once the person agrees, before opening another template, and take that one in", async () => {
    const reminder = LISTED[0] as ListedTemplate;
    const { podJobs, saves, state } = serve({
      jobs: { "notify.list": { status: "done", result: { templates: LISTED, truncated: false } }, "notify.pull": { status: "done", result: { version: 3 } } }
    });
    await open();
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Template"), { target: { value: reminder.id } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(confirm).toHaveBeenCalled();
    expect(podJobs.filter((job) => job.kind === "notify.pull")).toHaveLength(0);

    confirm.mockReturnValue(true);
    state.latest = view({
      version: 3,
      by: "user",
      template_id: reminder.id,
      type: "sms",
      name: reminder.name,
      subject: null,
      notify_subject: null,
      body: "Hi ((name))",
      notify_body: "Hi ((name))",
      notify_preview: "Hi ((name))"
    });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await wait(SAVE_AFTER_MS);

    expect(podJobs.filter((job) => job.kind === "notify.pull")).toHaveLength(1);
    expect(saves).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: reminder.name })).toBeTruthy();
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("");
  });

  it("should say a product has no templates", async () => {
    serve({ latest: null, jobs: { "notify.list": { status: "done", result: { templates: [], truncated: false } } } });
    await open({ notify: null });

    fireEvent.change(screen.getByLabelText("Product"), { target: { value: "pcs" } });
    await wait();

    expect(screen.getByText("That product's Notify service has no templates.")).toBeTruthy();
    expect((screen.getByLabelText("Template") as HTMLSelectElement).disabled).toBe(true);
  });

  it("should list the open template's product and say when Notify has a newer version of it", async () => {
    const { podJobs } = serve({ jobs: { "notify.list": { status: "done", result: { templates: [{ ...LISTED[1], version: 6 }], truncated: false } } } });
    await open();

    expect(podJobs[0]).toEqual({ kind: "notify.list", args: { product: "pcs" } });
    expect((screen.getByLabelText("Product") as HTMLSelectElement).value).toBe("pcs");
    expect(screen.getByText(/Notify has a newer version of this template \(version 6\) than this draft was taken from \(version 4\)/)).toBeTruthy();
  });

  it("should have no picker in a chat with no pod, though its owner can still edit", async () => {
    const { podJobs } = serve();
    await open({ canPick: false });

    expect(screen.queryByLabelText("Product")).toBeNull();
    expect(screen.getByRole("tab", { name: "Edit" })).toBeTruthy();
    expect(podJobs).toHaveLength(0);
  });
});

describe("NotifyPanel versions and readers", () => {
  it("should show an older version read-only, and go back to the latest", async () => {
    serve({
      versions: [
        { version: 2, by: "user", name: "Claim received", notify_version: 4, summary: "Edited the template", updated_at: "" },
        { version: 1, by: "agent", name: "Claim received", notify_version: 4, summary: null, updated_at: "" }
      ],
      older: { 1: view({ version: 1, body: "Old ((name))", data: { name: "Old" } }) }
    });
    await open();

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1" } });
    await wait();

    expect(screen.getByText("Version 1 is not the latest, so it can't be edited.")).toBeTruthy();
    expect((screen.getByLabelText("name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("tab", { name: "Edit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to the latest" }));
    expect(screen.getByRole("tab", { name: "Edit" })).toBeTruthy();
  });

  it("should name the person's versions as the owner's to a reader", async () => {
    serve({ versions: [{ version: 2, by: "user", name: "Claim received", notify_version: 4, summary: null, updated_at: "" }] });
    await open({ owner: false });

    expect(screen.getByRole("option", { name: "Version 2, by the owner" })).toBeTruthy();
  });

  it("should say when an older version could not be read", async () => {
    serve({
      versions: [
        { version: 2, by: "agent", name: "x", notify_version: 4, summary: null, updated_at: "" },
        { version: 1, by: "agent", name: "x", notify_version: 4, summary: null, updated_at: "" }
      ]
    });
    await open();

    fireEvent.change(screen.getByLabelText("Version"), { target: { value: "1" } });
    await wait();

    expect(screen.getByText("Couldn't load version 1.")).toBeTruthy();
  });

  it("should offer another try when the template could not be read", async () => {
    const { fetchMock } = serve();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 500 }));
    await open();

    expect(screen.getByRole("alert").textContent).toMatch(/Could not load the Notify template/);
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/versions") ? { versions: [] } : view())));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await wait();
    expect(screen.getByRole("heading", { name: "Claim received" })).toBeTruthy();
  });

  it("should show a shared chat's reader the template with no picker, no editing and no saves", async () => {
    const { fetchMock, podJobs } = serve({ latest: view({ data: { name: "Ada" } }) });
    render(<SharedNotify conversationId={CONVERSATION} notify={SUMMARY} />);
    await wait();

    expect(screen.queryByLabelText("Product")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Notify template" })).toBeNull();
    const field = screen.getByLabelText("name") as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    fireEvent.change(field, { target: { value: "Bea" } });
    await wait(SAVE_AFTER_MS);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);
    expect(podJobs).toHaveLength(0);
  });

  it("should tell a reader there is no template when there is none", async () => {
    serve({ latest: null });
    await open({ notify: null, owner: false });

    expect(screen.getByText("This chat has no Notify template.")).toBeTruthy();
  });
});
