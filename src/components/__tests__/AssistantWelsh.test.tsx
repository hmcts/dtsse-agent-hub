/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WelshKind, WelshResponse, WelshTask } from "@/assistant/welsh";
import { PRODUCT_KEY, WelshPage } from "@/components/assistant/WelshPage";
import { SEARCH_AFTER_MS } from "@/components/assistant/WelshSearch";
import type { WelshClient, WelshJobRequest } from "@/components/assistant/welshClient";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const PRODUCTS = [
  { slug: "cath", label: "CaTH (Court and Tribunal Hearings)" },
  { slug: "pcs", label: "Possession Claims Service (PCS)" }
];
const FILE = { file_id: "f-req", name: "cath-welsh-request-2026-10-29.xlsx", bytes: 100 };

const done = (kind: WelshKind, result: Record<string, unknown>, files = [] as (typeof FILE)[]): WelshResponse => ({ status: "done", kind, result, files });

const ANSWERS: Partial<Record<WelshKind, WelshResponse>> = {
  info: done("info", {
    initialised: true,
    repos: [{ path: "apps/cath/cath-service", staffOnly: ["apps/web/src/pages/(admin)/**"] }],
    catalogue: { approved: 1123, needsReview: 94 },
    shared: { approved: 0 }
  }),
  search: done("search", {
    total: 1,
    hits: [{ id: "r1", english: "Back to top", welsh: "Yn ôl i frig y dudalen", context: "", status: "approved", source: "legacy", catalogue: "cath" }]
  }),
  scan: done(
    "scan",
    {
      summary: { total: 354, unique: 231, fromCatalogue: 49, ambiguous: 1, toWlu: 180 },
      ambiguous: [
        { ref: "CY-AAAAAAAA", english: "Yes", where: "a/cy.ts:3 (en.yes)", options: [{ id: "0123456789", welsh: "Ydw", context: "", source: "legacy" }] }
      ],
      toWlu: [],
      fromCatalogue: [],
      message: "354 place(s) need Welsh"
    },
    [FILE]
  ),
  apply_preview: done("apply_preview", {
    applied: 50,
    files: ["a/cy.ts"],
    skipped: [{ where: "b/cy.ts:x", english: "y", reason: "no matching export" }],
    verify: { ok: true },
    diff: '+  yes: "Ydw"',
    changes: [{ page: "add list type", english: "Yes", now: "Shows the English", welsh: "Ydw", source: "legacy (BA choice, row 0123456789)" }]
  }),
  apply: done("apply", {
    applied: 50,
    files: ["a/cy.ts"],
    skipped: [],
    pr: "https://github.com/hmcts/cath-service/pull/9",
    branch: "welsh/x",
    verify: { ok: true }
  }),
  import_check: done("import_check", {
    added: 3,
    superseded: 0,
    unchanged: 0,
    conflicting: 1,
    blank: 1,
    problems: [{ row: 2, ref: "CY-1", english: "Hi", problem: "Ref does not match" }]
  }),
  import: done("import", { added: 3, superseded: 0, conflicting: 1, pr: "https://github.com/hmcts/cft-workspace/pull/300" }, [
    { file_id: "f-q", name: "return-queries.xlsx", bytes: 5 }
  ]),
  story_candidates: done("story_candidates", {
    summary: "Reduce confusion",
    url: "https://hmcts.atlassian.net/browse/DTSSTCI-1927",
    candidates: [
      { english: "Upload documents", origin: "after-shown" },
      { english: "Start now", origin: "quoted" }
    ],
    existing: []
  }),
  story_preview: done("story_preview", {
    rows: [
      { ref: "CY-BBBBBBBB", english: "Upload documents", welsh: '[WELSH TRANSLATION REQUIRED: "Upload documents"]', source: "Sent to WLU", state: "required" }
    ],
    verify: { ok: true, failures: [] }
  }),
  story_write: done("story_write", { url: "https://hmcts.atlassian.net/browse/DTSSTCI-1927", counts: { required: 1 } }, [
    { file_id: "f-s", name: "DTSSTCI-1927-welsh-request.xlsx", bytes: 9 }
  ])
};

function client(answers: Partial<Record<WelshKind, WelshResponse>> = ANSWERS) {
  const requests: WelshJobRequest[] = [];
  const fake: WelshClient = {
    start: vi.fn(async (request: WelshJobRequest): Promise<WelshResponse> => {
      requests.push(request);
      return answers[request.kind] ?? { status: "failed", detail: "no answer" };
    }),
    read: vi.fn(async () => ({ status: "timeout" }) as WelshResponse),
    upload: vi.fn(async () => ({ file_id: "11111111-1111-4111-8111-111111111111" })),
    wait: vi.fn(async () => undefined)
  };
  return { fake, requests };
}

const SET_UP = /1,123 approved translations, 94 needing review · 1 repo · admin pages skipped/;

/** The page opened on a task for CaTH, once step 1 has said what CaTH has set up. */
async function open(task: WelshTask, answers?: Partial<Record<WelshKind, WelshResponse>>) {
  const { fake, requests } = client(answers);
  render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask={task} client={fake} />);
  await screen.findByText(answers?.info && answers.info !== ANSWERS.info ? /approved translation|not set up for Welsh/ : SET_UP);
  return { fake, requests };
}

const kinds = (fake: WelshClient) => vi.mocked(fake.start).mock.calls.map(([r]) => r);

const twoRepos = done("info", {
  initialised: true,
  repos: [{ path: "apps/cath/cath-service" }, { path: "apps/cath/cath-frontend" }],
  catalogue: { approved: 5, needsReview: 0 },
  shared: { approved: 0 }
});

describe("WelshPage", () => {
  it("should open on the tasks, and ask for the service as the first step of the one picked", async () => {
    // Arrange
    const { fake } = client();
    render(<WelshPage products={PRODUCTS} client={fake} />);

    expect(screen.getByRole("note").textContent).toMatch(/Welsh catalogue/);

    // Act
    fireEvent.click(screen.getByRole("button", { name: /Find Welsh that's missing/ }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cath" } });

    // Assert
    expect(await screen.findByText(SET_UP)).toBeTruthy();
    expect(window.localStorage.getItem(PRODUCT_KEY)).toBe("cath");
    fireEvent.click(screen.getByRole("button", { name: "← All tasks" }));
    expect(screen.getByText("What do you need to do?")).toBeTruthy();
  });

  it("should start on the service this browser used last, and ask again when it is changed", async () => {
    // Arrange
    window.localStorage.setItem(PRODUCT_KEY, "pcs");
    const { fake } = client();
    render(<WelshPage products={PRODUCTS} initialTask="search" client={fake} />);
    await screen.findByText(SET_UP);

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Change service" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cath" } });

    // Assert
    await waitFor(() =>
      expect(
        kinds(fake)
          .filter((r) => r.kind === "info")
          .map((r) => r.product)
      ).toEqual(["pcs", "cath"])
    );
  });

  it("should search the catalogue as the person types, and show the Welsh as the catalogue has it", async () => {
    // Arrange
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = await open("search");

    // Act
    fireEvent.change(screen.getByLabelText("English or Welsh"), { target: { value: "back to top" } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_AFTER_MS);
    });

    // Assert
    expect((await screen.findByText("Yn ôl i frig y dudalen")).getAttribute("lang")).toBe("cy");
    expect(requests.find((r) => r.kind === "search")).toEqual({ kind: "search", product: "cath", args: { query: "back to top", mode: "contains" } });
  });

  it("should find missing Welsh, offer the request to download, take a choice, preview, and open a PR only once confirmed", async () => {
    // Arrange
    const { requests } = await open("scan");

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByText("new, for the Welsh unit");
    fireEvent.click(screen.getByRole("radio", { name: "Ydw" }));
    fireEvent.click(screen.getByRole("button", { name: "Put the 50 into the code" }));
    await screen.findByText(/50 Welsh values would go into 1 file/);
    expect(screen.getByRole("table", { name: "add list type" })).toBeTruthy();
    expect(screen.getByText("Your choice")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a pull request…" }));
    expect(requests.some((r) => r.kind === "apply")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open the draft pull request" }));

    // Assert
    expect((await screen.findByRole("link", { name: /pull\/9/ })).getAttribute("href")).toBe("https://github.com/hmcts/cath-service/pull/9");
    expect(screen.getByRole("link", { name: `Download ${FILE.name}` }).getAttribute("href")).toBe("/api/ui/assistant/welsh/files/f-req");
    expect(requests.find((r) => r.kind === "apply")).toEqual({
      kind: "apply",
      product: "cath",
      args: { repo: "apps/cath/cath-service", choices: [{ ref: "CY-AAAAAAAA", row_id: "0123456789" }] }
    });
  });

  it("should check a returned spreadsheet as soon as it is chosen, then add it to the catalogue and offer the queries", async () => {
    // Arrange
    const { fake, requests } = await open("return");

    // Act
    fireEvent.change(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/), { target: { files: [new File(["PK"], "return.xlsx")] } });
    await screen.findByText(/4 rows can be used/);
    fireEvent.click(screen.getByRole("button", { name: "Add to the catalogue" }));

    // Assert
    expect(await screen.findByRole("link", { name: /cft-workspace\/pull\/300/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Download return-queries.xlsx" })).toBeTruthy();
    expect(fake.upload).toHaveBeenCalledTimes(1);
    expect(requests.filter((r) => r.kind.startsWith("import")).map((r) => r.kind)).toEqual(["import_check", "import"]);
    expect(screen.getByText(/Row 2, “Hi”: Ref does not match/)).toBeTruthy();
  });

  it("should say why an upload was refused", async () => {
    const { fake } = await open("return");
    vi.mocked(fake.upload).mockResolvedValueOnce({ error: "That is not an Excel spreadsheet (.xlsx)." });
    fireEvent.change(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/), { target: { files: [new File(["x"], "notes.xlsx")] } });
    expect((await screen.findByRole("alert")).textContent).toMatch("That is not an Excel spreadsheet");
  });

  it("should build a story's Welsh table from only the strings the person ticked, and write it once confirmed", async () => {
    // Arrange
    const { requests } = await open("story");

    // Act
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "dtsstci-1927" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Upload documents" }));
    fireEvent.click(screen.getByRole("button", { name: "Build the Welsh table" }));
    await screen.findByText("For the Welsh unit");
    fireEvent.click(screen.getByRole("button", { name: "Add to the Jira story…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add it to the story" }));

    // Assert
    expect(await screen.findByRole("link", { name: "Download DTSSTCI-1927-welsh-request.xlsx" })).toBeTruthy();
    expect(requests.find((r) => r.kind === "story_preview")).toEqual({
      kind: "story_preview",
      product: "cath",
      args: { key: "DTSSTCI-1927", strings: ["Upload documents"] }
    });
    expect(requests.find((r) => r.kind === "story_write")).toEqual({ kind: "story_write", product: "cath", args: { key: "DTSSTCI-1927" } });
  });

  it("should refuse to write a story table whose Welsh cannot be traced", async () => {
    await open("story", {
      ...ANSWERS,
      story_preview: done("story_preview", {
        rows: [{ ref: "CY-C", english: "Start now", welsh: "Dechrau nawr", source: "typed", state: "hand-edited" }],
        verify: { ok: false, failures: [{ english: "Start now", reason: "no approved catalogue row or WLU return for this English" }] }
      })
    });
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "PUB-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Start now" }));
    fireEvent.click(screen.getByRole("button", { name: "Build the Welsh table" }));
    expect(await screen.findByText(/This table cannot be added/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to the Jira story…" })).toBeNull();
  });

  it.each<[WelshResponse, RegExp]>([
    [{ status: "signed_out", detail: "Your assistant needs you to sign in to GitHub again." }, /sign in to GitHub/],
    [{ status: "unsupported" }, /needs an update/],
    [{ status: "timeout" }, /did not answer in time/]
  ])("should tell the person what to do when a job comes back %j", async (response, said) => {
    const { fake } = client({ ...ANSWERS, info: response });
    render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask="search" client={fake} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(said);
  });
});

describe("WelshPage, the less common paths", () => {
  it("should start the scan afresh for another repo, and let a choice be taken back", async () => {
    // Arrange
    const { fake } = await open("scan", { ...ANSWERS, info: twoRepos });

    // Act
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "apps/cath/cath-frontend" } });
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Ydw" }));
    fireEvent.click(screen.getByRole("radio", { name: "Send it to the Welsh unit" }));
    fireEvent.click(screen.getByRole("button", { name: "Put the 49 into the code" }));
    await screen.findByText(/50 Welsh values/);

    // Assert
    expect(kinds(fake).find((r) => r.kind === "scan")?.args).toEqual({ repo: "apps/cath/cath-frontend" });
    expect(kinds(fake).find((r) => r.kind === "apply_preview")?.args).toEqual({ repo: "apps/cath/cath-frontend" });
    expect(screen.getByText(/1 place need a developer/)).toBeTruthy();
  });

  it("should say when a service has no repos or no catalogue yet", async () => {
    await open("scan", { ...ANSWERS, info: done("info", { initialised: false, repos: [] }) });
    expect(screen.getByText(/This service is not set up for Welsh yet/)).toBeTruthy();
    expect(screen.getByText(/No repos are set up for this service yet/)).toBeTruthy();
  });

  it("should put a return into the repo chosen after it is added, and start again with another spreadsheet", async () => {
    // Arrange
    const { fake } = await open("return", { ...ANSWERS, info: twoRepos });
    fireEvent.change(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/), { target: { files: [new File(["PK"], "return.xlsx")] } });
    fireEvent.click(await screen.findByRole("button", { name: "Add to the catalogue" }));
    await screen.findByLabelText("Repo to put them in");

    // Act
    fireEvent.change(screen.getByLabelText("Repo to put them in"), { target: { value: "apps/cath/cath-frontend" } });
    fireEvent.click(screen.getByRole("button", { name: "Put them into the code" }));
    await screen.findByText(/50 Welsh values/);
    fireEvent.click(screen.getByRole("button", { name: "Use a different spreadsheet" }));

    // Assert
    expect(kinds(fake).find((r) => r.kind === "apply_preview")?.args).toEqual({
      repo: "apps/cath/cath-frontend",
      file_id: "11111111-1111-4111-8111-111111111111"
    });
    expect(screen.queryByRole("button", { name: "Add to the catalogue" })).toBeNull();
    expect(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/)).toBeTruthy();
  });

  it("should rebuild a story table with the person's choice between catalogue renderings, and cancel a write", async () => {
    // Arrange
    const ambiguous = done("story_preview", {
      rows: [
        {
          ref: "CY-DDDDDDDD",
          english: "Upload documents",
          welsh: '[WELSH TRANSLATION REQUIRED: "Upload documents"]',
          source: "2 catalogue options",
          state: "ambiguous",
          options: [
            { id: "aaaaaaaaaa", welsh: "Uwchlwytho dogfennau", context: "button", source: "WLU" },
            { id: "bbbbbbbbbb", welsh: "Llwytho dogfennau i fyny", context: "", source: "WLU" }
          ]
        }
      ],
      verify: { ok: true, failures: [] }
    });
    const { fake } = await open("story", { ...ANSWERS, story_preview: ambiguous });
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "PUB-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    const box = await screen.findByRole("checkbox", { name: "Upload documents" });
    fireEvent.click(box);
    fireEvent.click(box);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Build the Welsh table" }));

    // Act
    fireEvent.click(await screen.findByRole("radio", { name: /Uwchlwytho dogfennau/ }));
    fireEvent.click(screen.getByRole("button", { name: "Use my choices" }));
    await waitFor(() => expect(kinds(fake).filter((r) => r.kind === "story_preview")).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Add to the Jira story…" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Assert
    expect(
      kinds(fake)
        .filter((r) => r.kind === "story_preview")
        .at(-1)?.args
    ).toEqual({
      key: "PUB-1",
      strings: ["Upload documents"],
      choices: [{ ref: "CY-DDDDDDDD", row_id: "aaaaaaaaaa" }]
    });
    expect(screen.getByRole("button", { name: "Add to the Jira story…" })).toBeTruthy();
  });

  it("should say when a story has nothing that looks like content, and show a link to anywhere else as text", async () => {
    await open("story", {
      ...ANSWERS,
      story_candidates: done("story_candidates", { summary: "S", url: "https://evil.example/x", candidates: [], existing: [] })
    });
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "PUB-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    expect(await screen.findByText(/No English content was found/)).toBeTruthy();
    expect(screen.getByText("https://evil.example/x").tagName).toBe("SPAN");
  });

  it("should tell the person while their assistant is starting, and carry on by itself", async () => {
    // Arrange
    let calls = 0;
    const { fake } = client();
    vi.mocked(fake.start).mockImplementation(async (request) => {
      calls++;
      return calls === 1 ? { status: "waking" } : (ANSWERS[request.kind] as WelshResponse);
    });
    let release: () => void = () => {};
    vi.mocked(fake.wait).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    // Act
    render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask="search" client={fake} />);

    // Assert
    expect(await screen.findByText(/Your assistant is starting/)).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByText(SET_UP)).toBeTruthy();
  });
});
