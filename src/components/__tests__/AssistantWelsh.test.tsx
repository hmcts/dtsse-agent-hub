/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WelshKind, WelshResponse, WelshTask } from "@/assistant/welsh";
import { PRODUCT_KEY, stepsIn, WelshPage } from "@/components/assistant/WelshPage";
import { fileFacts, JobStatus } from "@/components/assistant/WelshParts";
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
  scan: done("scan", {
    summary: { total: 354, unique: 231, fromCatalogue: 49, ambiguous: 1, toWlu: 180 },
    ambiguous: [
      { ref: "CY-AAAAAAAA", english: "Yes", where: "a/cy.ts:3 (en.yes)", options: [{ id: "0123456789", welsh: "Ydw", context: "", source: "legacy" }] }
    ],
    toWlu: [],
    fromCatalogue: [],
    message: "354 place(s) need Welsh"
  }),
  request: done("request", { left_out: 0 }, [FILE]),
  keep_english: done("keep_english", { added: ["ServiceNow"], already: 0, pr: "https://github.com/hmcts/cath-service/pull/12" }),
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
  await screen.findByText(answers?.info && answers.info !== ANSWERS.info ? /approved translation|Not set up for Welsh/ : SET_UP);
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
  it("should ask for the service first, and offer the tasks only once it is known to be set up", async () => {
    // Arrange
    const { fake } = client();
    render(<WelshPage products={PRODUCTS} client={fake} />);

    expect(screen.queryByRole("button", { name: /Find Welsh that's missing/ })).toBeNull();

    // Act
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "cath" } });
    fireEvent.click(await screen.findByRole("button", { name: /Find Welsh that's missing/ }));

    // Assert
    expect(screen.getByText(SET_UP)).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button", { name: "Make the spreadsheet of 181 strings" }));
    await screen.findByRole("link", { name: `Download ${FILE.name}` });
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

  const CHECKED = done("scan", {
    summary: { total: 4, unique: 3, fromCatalogue: 1, ambiguous: 0, toWlu: 5 },
    toWlu: [
      { ref: "CY-11111111", english: "Choose a file", page: "upload", where: "pages/upload/cy.ts:3 (en.choose)", hint: null, keepable: false },
      {
        ref: "CY-22222222",
        english: "ServiceNow",
        page: "sso rejected",
        where: "pages/sso-rejected/cy.ts:6 (en.linkText)",
        hint: "Looks like the name of a product or system, which usually stays in English.",
        keepable: true
      }
    ],
    fromCatalogue: [{ ref: "CY-33333333", english: "Back", welsh: "Yn ôl", page: "upload", where: "pages/upload/cy.ts:9 (en.back)" }]
  });

  it("should list the new strings page by page, ticked unless the scan said why not, and the catalogue's with their Welsh", async () => {
    // Arrange
    await open("scan", { ...ANSWERS, scan: CHECKED });

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "sso rejected" });

    // Assert
    expect((screen.getByRole("checkbox", { name: "Send “Choose a file”" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Send “ServiceNow”" }) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("Looks like the name of a product or system, which usually stays in English.")).toBeTruthy();
    expect(screen.getByText("Only the first 2 are listed. The other 3 always go in.")).toBeTruthy();
    expect(screen.getByText("pages/upload/cy.ts:3 (en.choose)")).toBeTruthy();
    expect(screen.getByText("The 1 string already in the catalogue")).toBeTruthy();
    expect(screen.getByText("Yn ôl").getAttribute("lang")).toBe("cy");
  });

  it("should make the spreadsheet without what was left out, then keep that English only once confirmed", async () => {
    // Arrange
    const { requests } = await open("scan", { ...ANSWERS, scan: CHECKED });
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "sso rejected" });

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Make the spreadsheet of 4 strings" }));
    await screen.findByRole("link", { name: `Download ${FILE.name}` });
    fireEvent.click(screen.getByRole("button", { name: "Don't ask about the 1 string I left out again…" }));
    expect(requests.some((r) => r.kind === "keep_english")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Open the draft pull request" }));

    // Assert
    expect((await screen.findByRole("link", { name: /pull\/12/ })).getAttribute("href")).toBe("https://github.com/hmcts/cath-service/pull/12");
    expect(requests.find((r) => r.kind === "request")).toEqual({
      kind: "request",
      product: "cath",
      args: { repo: "apps/cath/cath-service", leave_out: ["CY-22222222"] }
    });
    expect(requests.find((r) => r.kind === "keep_english")).toEqual({ kind: "keep_english", product: "cath", args: { strings: ["ServiceNow"] } });
  });

  it("should keep a hinted string with no Welsh yet ticked, and say why", async () => {
    // Arrange
    const scan = done("scan", {
      summary: { total: 1, unique: 1, fromCatalogue: 0, ambiguous: 0, toWlu: 1 },
      toWlu: [
        {
          ref: "CY-44444444",
          english: "Rolls Building",
          page: "list",
          where: "list/cy.ts:2 (en.locationLine1)",
          hint: "Part of an address.",
          keepable: false,
          suggest_leave_out: false
        }
      ]
    });
    await open("scan", { ...ANSWERS, scan });

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "list" });

    // Assert
    expect((screen.getByRole("checkbox", { name: "Send “Rolls Building”" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/It has no Welsh yet, though, so left out it would have none: it stays ticked\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Don't ask about/ })).toBeNull();
  });

  it("should offer to keep English before any spreadsheet, and keep the pull request when a tick changes after", async () => {
    // Arrange
    const { requests } = await open("scan", { ...ANSWERS, scan: CHECKED });
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "sso rejected" });

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Don't ask about the 1 string I left out again…" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the draft pull request" }));
    await screen.findByRole("link", { name: /pull\/12/ });
    fireEvent.click(screen.getByRole("checkbox", { name: "Send “Choose a file”" }));

    // Assert
    expect(screen.getByRole("link", { name: /pull\/12/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Don't ask about/ })).toBeNull();
    expect(requests.filter((r) => r.kind === "keep_english")).toHaveLength(1);
  });

  it("should offer the scan's own spreadsheet when the assistant is too old to leave strings out", async () => {
    // Arrange
    const scan = { ...CHECKED, files: [FILE] } as WelshResponse;
    await open("scan", { ...ANSWERS, scan, request: { status: "unsupported" } });
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "sso rejected" });

    // Act
    fireEvent.click(screen.getByRole("button", { name: "Make the spreadsheet of 4 strings" }));

    // Assert
    expect(await screen.findByText(/Until your assistant updates, it can only make the spreadsheet of every string\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: `Download ${FILE.name}` })).toBeTruthy();
  });

  it("should drop the spreadsheet when a tick changes, and tick everything or go back to the suggestions", async () => {
    // Arrange
    await open("scan", { ...ANSWERS, scan: CHECKED });
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByRole("table", { name: "sso rejected" });
    fireEvent.click(screen.getByRole("button", { name: "Make the spreadsheet of 4 strings" }));
    await screen.findByRole("link", { name: `Download ${FILE.name}` });

    // Act
    fireEvent.click(screen.getByRole("checkbox", { name: "Send “Choose a file”" }));

    // Assert
    expect(screen.queryByRole("link", { name: `Download ${FILE.name}` })).toBeNull();
    expect(screen.getByRole("button", { name: "Make the spreadsheet of 3 strings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tick all" }));
    expect(screen.getByRole("button", { name: "Make the spreadsheet of 5 strings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to the suggestions" }));
    expect(screen.getByRole("button", { name: "Make the spreadsheet of 4 strings" })).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText("Which part of the service (code repository)"), { target: { value: "apps/cath/cath-frontend" } });
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

  it("should say when a service has no repos yet", async () => {
    await open("scan", { ...ANSWERS, info: done("info", { initialised: true, repos: [], catalogue: { approved: 1 } }) });
    expect(screen.getByText(/No code repositories are set up for this service yet/)).toBeTruthy();
  });

  it("should say when a service has no catalogue and nowhere to keep one", async () => {
    const { fake } = client({ ...ANSWERS, info: done("info", { initialised: false, repos: [], candidates: [] }) });
    render(<WelshPage products={PRODUCTS} initialProduct="cath" client={fake} />);
    expect(await screen.findByText(/Not set up for Welsh yet/)).toBeTruthy();
    expect(screen.getByText(/no repos in the CFT Workspace/)).toBeTruthy();
  });

  it("should send a task opened for a service with no catalogue back to set it up, offering no task", async () => {
    await open("scan", { ...ANSWERS, info: done("info", { initialised: false, repos: [], candidates: ["apps/cath/cath-service"] }) });
    expect(screen.queryByRole("button", { name: "Find missing Welsh" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Set it up" }));
    expect(screen.getByRole("heading", { name: /Set up CaTH .* for Welsh/ })).toBeTruthy();
    expect(screen.queryByText("What do you need to do?")).toBeNull();
  });

  it("should put a return into the repo chosen after it is added, and start again with another spreadsheet", async () => {
    // Arrange
    const { fake } = await open("return", { ...ANSWERS, info: twoRepos });
    fireEvent.change(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/), { target: { files: [new File(["PK"], "return.xlsx")] } });
    fireEvent.click(await screen.findByRole("button", { name: "Add to the catalogue" }));
    await screen.findByLabelText("Which part of the service (code repository) to put them in");

    // Act
    fireEvent.change(screen.getByLabelText("Which part of the service (code repository) to put them in"), { target: { value: "apps/cath/cath-frontend" } });
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

describe("WelshPage, getting through a task", () => {
  it("should offer Try again when a step fails, and send the same request again when it is pressed", async () => {
    const { fake } = client();
    vi.mocked(fake.start)
      .mockResolvedValueOnce({ status: "failed", detail: "That did not work." })
      .mockResolvedValueOnce(ANSWERS.info as WelshResponse);
    render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask="search" client={fake} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByText(SET_UP)).toBeTruthy();
    expect(kinds(fake).map((r) => r.kind)).toEqual(["info", "info"]);
  });

  it("should offer no Try again when the assistant needs an update, which another try would not change", async () => {
    const { fake } = client({ ...ANSWERS, info: { status: "unsupported" } as WelshResponse });
    render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask="search" client={fake} />);

    expect(await screen.findByText(/needs an update to do this/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });

  it("should ask the person to check before trying again when a write timed out, since it may still have been done", async () => {
    const { requests } = await open("story", { ...ANSWERS, story_write: { status: "timeout" } as WelshResponse });
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "dtsstci-1927" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Upload documents" }));
    fireEvent.click(screen.getByRole("button", { name: "Build the Welsh table" }));
    await screen.findByText("For the Welsh unit");
    fireEvent.click(screen.getByRole("button", { name: "Add to the Jira story…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add it to the story" }));

    expect(await screen.findByText("Your assistant did not answer in time, but it may still have done this. Check before you try again.")).toBeTruthy();
    // No Try again for a write: the step's own button is the way, and it sends what the page says now.
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
    expect(requests.filter((r) => r.kind === "story_write")).toHaveLength(1);
  });

  it("should ask the person to check first when the connection dropped while a write was waiting", async () => {
    const { fake } = await open("story");
    vi.mocked(fake.start).mockImplementation(async (request) => {
      if (request.kind === "story_write") {
        throw new Error("offline");
      }
      return ANSWERS[request.kind] as WelshResponse;
    });
    fireEvent.change(screen.getByLabelText("Jira story"), { target: { value: "dtsstci-1927" } });
    fireEvent.click(screen.getByRole("button", { name: "Find its English" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Upload documents" }));
    fireEvent.click(screen.getByRole("button", { name: "Build the Welsh table" }));
    await screen.findByText("For the Welsh unit");
    fireEvent.click(screen.getByRole("button", { name: "Add to the Jira story…" }));
    fireEvent.click(screen.getByRole("button", { name: "Add it to the story" }));

    expect(await screen.findByText(/it may still have done this\. Check before you try again\./)).toBeTruthy();
  });

  it("should say a read failed in its own words, and offer Try again, when the connection dropped while it waited", async () => {
    const { fake } = client();
    vi.mocked(fake.start).mockRejectedValueOnce(new Error("offline"));
    render(<WelshPage products={PRODUCTS} initialProduct="cath" initialTask="search" client={fake} />);

    expect(await screen.findByText("That did not work. Check your connection and try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("should say how many steps a task has, and its own number only until the code check has said", async () => {
    await open("story");
    expect(screen.getByText("Step 1 of 5")).toBeTruthy();
    expect(screen.getByText("Step 2 of 5")).toBeTruthy();

    expect(screen.getByRole("heading", { name: "Step 2 of 5: The story" })).toBeTruthy();

    cleanup();
    await open("scan");
    expect(screen.getByText("Step 1")).toBeTruthy();
    expect(screen.getByText("Step 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByText("new, for the Welsh unit");
    // The service's step takes the total too, once the check has said it, which is a render after the check's own.
    expect(await screen.findByText("Step 1 of 5")).toBeTruthy();
    expect(screen.getByText("Step 2 of 5")).toBeTruthy();
  });

  it("should count a return's steps only as far as they will go when nothing in the spreadsheet can be used", async () => {
    await open("return", {
      ...ANSWERS,
      import_check: done("import_check", { added: 0, superseded: 0, unchanged: 0, conflicting: 0, blank: 2, problems: [] })
    });
    fireEvent.change(screen.getByLabelText(/The .xlsx the Welsh Language Unit sent back/), { target: { files: [new File(["PK"], "return.xlsx")] } });

    expect(await screen.findByText("Step 3 of 3")).toBeTruthy();
  });

  it("should say a service with no repos has two steps to its code check", async () => {
    await open("scan", {
      ...ANSWERS,
      info: done("info", { initialised: true, repos: [], catalogue: { approved: 1, needsReview: 0 }, shared: { approved: 0 } })
    });

    expect(await screen.findByText("Step 2 of 2")).toBeTruthy();
  });

  it("should put the task in the address as it is chosen, and follow the browser's Back to the list", async () => {
    window.history.replaceState(null, "", "/assistant/welsh?product=cath");
    const { fake } = client();
    render(<WelshPage products={PRODUCTS} initialProduct="cath" client={fake} />);

    fireEvent.click(await screen.findByRole("button", { name: /Look up a translation/ }));
    expect(window.location.search).toBe("?product=cath&task=search");

    act(() => {
      window.history.replaceState(null, "", "/assistant/welsh?product=cath");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByText("What do you need to do?")).toBeTruthy();

    act(() => {
      window.history.replaceState(null, "", "/assistant/welsh?product=cath&task=story");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("heading", { name: "Add Welsh to a Jira story" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "← All tasks" }));
    expect(window.location.search).toBe("?product=cath");
  });

  it("should say what a spreadsheet is and what to do with it, then offer the task that comes next with the service kept", async () => {
    await open("scan");
    fireEvent.click(screen.getByRole("button", { name: "Find missing Welsh" }));
    await screen.findByText("new, for the Welsh unit");
    fireEvent.click(screen.getByRole("button", { name: "Make the spreadsheet of 181 strings" }));
    await screen.findByRole("link", { name: `Download ${FILE.name}` });

    expect(screen.getByText("(Excel spreadsheet, 100 bytes)")).toBeTruthy();
    expect(screen.getByText(/email it to the Welsh Language Unit/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "The Welsh unit sent translations back" }));

    expect(screen.getByRole("heading", { name: "The Welsh unit sent translations back" })).toBeTruthy();
    expect(screen.getByText(SET_UP)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get("task")).toBe("return");
  });
});

describe("WelshPage, setting a service up", () => {
  const notSetUp = (extra: Record<string, unknown> = {}) =>
    done("info", { initialised: false, repos: [], candidates: ["apps/cath/cath-frontend", "apps/cath/cath-service"], setupPr: null, ...extra });
  const checked = done("setup_check", {
    sources: 2,
    read: 120,
    added: 110,
    needsReview: 4,
    overriddenCopies: 3,
    conflicts: 1,
    conflictExamples: [
      {
        english: "Back",
        context: "",
        options: [
          { welsh: "Yn ôl", where: "legacy:old.xlsx row 3" },
          { welsh: "Nôl", where: "legacy:copy.json" }
        ]
      }
    ],
    unreadable: [],
    repo: "apps/cath/cath-service",
    dryRun: true
  });
  const SETUP = {
    ...ANSWERS,
    info: notSetUp(),
    setup_check: checked,
    setup: done("setup", { ...(checked.status === "done" ? checked.result : {}), pr: "https://github.com/hmcts/cath-service/pull/77" })
  };
  const ids = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222", "cccccccc-3333-4333-8333-333333333333"];

  /** The main page for CaTH, which is not set up, so it shows setting it up and no tasks. */
  async function openSetup(answers: Partial<Record<WelshKind, WelshResponse>>) {
    const { fake, requests } = client(answers);
    render(<WelshPage products={PRODUCTS} initialProduct="cath" client={fake} />);
    await screen.findByText(/Not set up for Welsh yet/);
    return { fake, requests };
  }

  /** Chooses the repo, which nothing is chosen for when the service has more than one. */
  function chooseRepo(repo = "apps/cath/cath-frontend") {
    fireEvent.change(screen.getByLabelText("Which repo keeps the service's Welsh"), { target: { value: repo } });
  }

  async function addFiles(fake: WelshClient, names: string[]) {
    for (const id of ids.slice(0, names.length)) {
      vi.mocked(fake.upload).mockResolvedValueOnce({ file_id: id });
    }
    fireEvent.change(screen.getByLabelText(/Spreadsheets \(.xlsx\) or JSON files/), { target: { files: names.map((n) => new File(["PK"], n)) } });
    await screen.findByText(names.at(-1) as string, { selector: ".break-all" });
  }

  it("should set a service up from several earlier files in the repo chosen, checked first and opened only once confirmed", async () => {
    // Arrange
    const { fake, requests } = await openSetup(SETUP);
    expect(screen.getByRole("list", { name: /Set up CaTH .* for Welsh/ }).textContent).toMatch(/Step 1 of 5/);
    expect(screen.getByRole("note").textContent).toMatch(/at least one document of translations the Welsh Language Unit has approved/);
    expect(screen.getByRole("note").textContent).toMatch(/reviewed and merged, you can use the other Welsh tasks/);
    expect(screen.queryByText("What do you need to do?")).toBeNull();
    expect((screen.getByLabelText("Which repo keeps the service's Welsh") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByText("Add your documents")).toBeNull();

    // Act
    fireEvent.change(screen.getByLabelText("Which repo keeps the service's Welsh"), { target: { value: "apps/cath/cath-service" } });
    await addFiles(fake, ["old.xlsx", "copy.json", "second.xlsx"]);
    fireEvent.click(screen.getByRole("button", { name: "Remove second.xlsx" }));
    fireEvent.click(screen.getByRole("button", { name: "Check them" }));
    await screen.findByText(/120 translations read from 2 files: 110 catalogue rows, 4 of them needing review/);
    fireEvent.click(screen.getByRole("button", { name: "Set up Welsh for this service" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the pull request" }));

    // Assert
    expect(await screen.findByRole("link", { name: /cath-service\/pull\/77/ })).toBeTruthy();
    const setups = requests.filter((r) => r.kind.startsWith("setup"));
    expect(setups.map((r) => r.kind)).toEqual(["setup_check", "setup"]);
    expect(setups[1]?.args).toEqual({ repo: "apps/cath/cath-service", file_ids: [ids[0], ids[1]] });
    expect(screen.getByText(/3 JSON entries left out/)).toBeTruthy();
    expect(screen.getByText(/“Back”: “Yn ôl” in old.xlsx row 3; “Nôl” in copy.json/)).toBeTruthy();
  });

  it("should not check anything until at least one document is added", async () => {
    const { fake, requests } = await openSetup(SETUP);
    chooseRepo();
    expect((screen.getByRole("button", { name: "Check them" }) as HTMLButtonElement).disabled).toBe(true);
    await addFiles(fake, ["old.xlsx"]);
    expect((screen.getByRole("button", { name: "Check them" }) as HTMLButtonElement).disabled).toBe(false);
    expect(requests.some((r) => r.kind === "setup_check")).toBe(false);
  });

  it("should name a file that could not be read, offer no setup until it is removed, and check again once it is", async () => {
    // Arrange
    const unreadable = done("setup_check", {
      ...(checked.status === "done" ? checked.result : {}),
      unreadable: [{ file: "notes.xlsx", problem: "no sheet has both an English and a Welsh header" }]
    });
    const { fake } = await openSetup({ ...SETUP, setup_check: unreadable });
    chooseRepo();

    // Act
    await addFiles(fake, ["notes.xlsx"]);
    vi.mocked(fake.upload).mockResolvedValueOnce({ error: "That is not a JSON file of English to Welsh." });
    fireEvent.change(screen.getByLabelText(/Spreadsheets \(.xlsx\) or JSON files/), { target: { files: [new File(["["], "bad.json")] } });
    await screen.findByText(/bad.json: That is not a JSON file/);
    fireEvent.click(screen.getByRole("button", { name: "Check them" }));

    // Assert
    expect(await screen.findByText(/notes.xlsx: no sheet has both/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up Welsh for this service" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.xlsx" }));
    expect((screen.getByRole("button", { name: "Check them" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should choose the repo for a service that has only one", async () => {
    await openSetup({ ...SETUP, info: notSetUp({ candidates: ["apps/cath/cath-service"] }) });
    expect(screen.queryByLabelText("Which repo keeps the service's Welsh")).toBeNull();
    expect(screen.getByText("Add your documents")).toBeTruthy();
    expect(screen.getByText(/check with the devs/)).toBeTruthy();
  });

  it("should link to a setup already open rather than offer another", async () => {
    await openSetup({ ...SETUP, info: notSetUp({ setupPr: "https://github.com/hmcts/cath-service/pull/70" }) });
    expect(screen.getByRole("link", { name: /cath-service\/pull\/70/ })).toBeTruthy();
    expect(screen.queryByLabelText(/Spreadsheets/)).toBeNull();
  });
});

describe("fileFacts", () => {
  it("should name the kind of file and give its size in the unit that reads best", () => {
    expect(fileFacts({ name: "a.xlsx", bytes: 2048 })).toBe("Excel spreadsheet, 2 KB");
    expect(fileFacts({ name: "a.csv", bytes: 300 })).toBe("CSV file, 300 bytes");
    expect(fileFacts({ name: "a.bin", bytes: 3 * 1024 * 1024 })).toBe("File, 3.0 MB");
    expect(fileFacts({ name: "a.xlsx", bytes: 1100 })).toBe("Excel spreadsheet, 1 KB");
    expect(fileFacts({ name: "a.xlsx", bytes: 1 })).toBe("Excel spreadsheet, 1 byte");
  });
});

describe("stepsIn", () => {
  it("should give a fixed total only for the tasks whose steps do not follow what they find", () => {
    expect(stepsIn("search")).toBe(2);
    expect(stepsIn("story")).toBe(5);
    expect(stepsIn("return")).toBeNull();
    expect(stepsIn("scan")).toBeNull();
  });
});

describe("JobStatus", () => {
  it("should hold Try again back while another job in the section is running, and send it once nothing is", () => {
    const retry = vi.fn();
    const failed = { phase: "failed" as const, response: { status: "failed", detail: "That did not work." } as WelshResponse, retry };
    const { rerender } = render(<JobStatus state={failed} working="Working…" busy />);

    const button = screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    rerender(<JobStatus state={failed} working="Working…" />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
