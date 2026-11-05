/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { savedCredentials } from "@/assistant/saved-credentials";
import { ActionForm } from "@/components/ActionForm";
import { ClaudeMd } from "@/components/assistant/ClaudeMdSettings";
import { Connections, type ConnectionsView } from "@/components/assistant/ConnectionSettings";
import { SettingsDrafts } from "@/components/assistant/useSettingsDraft";
import type { CredentialStatus } from "@/credentials/store";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/assistant",
  useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/components/live/HubStream", () => ({ useEndSession: () => () => undefined }));

afterEach(() => {
  cleanup();
});

const SECRET_NAMES = new Set(["value", "code", "token", "password", "secret"]);

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function stored(kind: CredentialStatus["kind"]): CredentialStatus {
  return { kind, stored: true, accountLabel: null, updatedAt: "2026-10-05T11:00:00.000Z" };
}

function missing(kind: CredentialStatus["kind"]): CredentialStatus {
  return { kind, stored: false, accountLabel: null, updatedAt: null };
}

/** The Connections section with only saved credentials to list. */
function credentials(rows: ReturnType<typeof savedCredentials>): ConnectionsView {
  return {
    list: [],
    access: null,
    connect: undefined,
    microsoft: null,
    route: "own-licence",
    unavailable: null,
    warning: null,
    tokens: { rows, unavailable: null, save: ok(), remove: ok() }
  };
}

/** Where a browser goes when the form is submitted natively, with no script to intercept it. */
function nativeSubmitUrl(form: HTMLFormElement): string {
  const target = new URL(form.getAttribute("action") || "/assistant", "https://agent-hub.example");
  if (form.method === "get") {
    const query = new URLSearchParams();
    for (const [name, value] of new FormData(form)) {
      query.append(name, String(value));
    }
    target.search = query.toString();
  }
  return target.toString();
}

function carriesSecret(form: HTMLFormElement): boolean {
  return [...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].some(
    (field) => field.type === "password" || SECRET_NAMES.has(field.name)
  );
}

function expectEveryFormPosts(container: HTMLElement): void {
  const forms = [...container.querySelectorAll("form")];
  expect(forms.length).toBeGreaterThan(0);
  for (const form of forms) {
    expect(form.getAttribute("method")?.toLowerCase(), form.getAttribute("aria-label") ?? "a form").toBe("post");
  }
}

function expectSecretInputsHidden(container: HTMLElement): void {
  for (const input of container.querySelectorAll<HTMLInputElement>("input")) {
    if (SECRET_NAMES.has(input.name)) {
      expect([input.name, input.type, input.getAttribute("autocomplete"), input.getAttribute("spellcheck")]).toEqual([input.name, "password", "off", "false"]);
    }
  }
}

function fill(container: HTMLElement): void {
  for (const input of container.querySelectorAll<HTMLInputElement>("input[type=password]")) {
    fireEvent.change(input, { target: { value: "11a2b3c4d5e6f708192a3b4c5d" } });
  }
}

describe("a form carrying a credential", () => {
  it("should be served as a POST form, so a submit before hydration keeps its fields out of the URL", () => {
    const markup = renderToStaticMarkup(
      <ActionForm action={ok()} label="Save your Jenkins API token">
        <input type="hidden" name="kind" value="jenkins" />
        <input name="value" type="password" defaultValue="11a2b3c4d5e6f708192a3b4c5d" />
      </ActionForm>
    );
    const form = new DOMParser().parseFromString(markup, "text/html").querySelector("form") as HTMLFormElement;

    expect(form.method).toBe("post");
    expect(nativeSubmitUrl(form)).toBe("https://agent-hub.example/assistant");
  });

  it("should post every paste form in the Assistant's settings, with the value hidden, when each is opened", () => {
    const rows = savedCredentials([stored("github"), stored("claude"), missing("jenkins")], "own-licence", true);
    const { container } = render(<Connections view={credentials(rows)} />);
    fireEvent.click(screen.getByRole("button", { name: "Replace your Claude token" }));
    fireEvent.click(screen.getByRole("button", { name: "Add your Jenkins API token" }));
    fill(container);

    expect([...container.querySelectorAll("form")].filter(carriesSecret).map((form) => form.getAttribute("aria-label"))).toEqual([
      "Save your Claude token",
      "Save your Jenkins API token"
    ]);
    expectEveryFormPosts(container);
    expectSecretInputsHidden(container);
    for (const form of container.querySelectorAll("form")) {
      expect(nativeSubmitUrl(form)).not.toContain("11a2b3c4d5e6f708192a3b4c5d");
    }
  });

  it("should post the remove form in the Assistant's settings", () => {
    const rows = savedCredentials([stored("claude")], "own-licence", true);
    const { container } = render(<Connections view={credentials(rows)} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove your Claude token" }));

    expect(screen.getByRole("form", { name: "Remove your Claude token" })).toBeTruthy();
    expectEveryFormPosts(container);
  });

  // The text itself is sent by the dialog's Save, which calls the action rather than submitting a form.
  it("should post the CLAUDE.md reset form", () => {
    const drafts = { drafts: {}, errors: {}, saves: 0, change: vi.fn(), settle: vi.fn() };
    const { container } = render(
      <SettingsDrafts.Provider value={drafts}>
        <ClaudeMd claudeMd={{ settings: { available: true, stored: true, text: "# Me", updatedAt: "2026-10-05T09:00:00.000Z" }, save: ok(), reset: ok() }} />
      </SettingsDrafts.Provider>
    );

    expect(container.querySelectorAll("form")).toHaveLength(1);
    expectEveryFormPosts(container);
  });
});

/** The topic searches, whose one field is the search itself and belongs in a shareable URL. */
const GET_FORMS = new Set(["src/app/hub/topics/page.tsx", "src/components/Sidebar.tsx"]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" || entry.name === "generated" ? [] : sources(path);
    }
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

/** Each `<form …>` opening tag, read to the `>` that is not inside a `{…}` expression. */
function formTags(source: string): string[] {
  const tags: string[] = [];
  for (let start = source.indexOf("<form"); start !== -1; start = source.indexOf("<form", start + 1)) {
    if (/[\w-]/.test(source[start + 5] ?? "")) {
      continue;
    }
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      } else if (character === ">" && depth === 0) {
        break;
      }
    }
    tags.push(source.slice(start, end + 1));
  }
  return tags;
}

describe("every form in the app", () => {
  const root = process.cwd();
  const files = sources(join(root, "src"));

  it("should be found by the scan, so the scan is not vacuous", () => {
    expect(files.filter((file) => formTags(readFileSync(file, "utf8")).length > 0).length).toBeGreaterThanOrEqual(6);
  });

  it.each(files.map((file) => relative(root, file)))("should name a method on each form in %s, and POST unless it is a search", (file) => {
    for (const tag of formTags(readFileSync(join(root, file), "utf8"))) {
      const method = /\bmethod="(\w+)"/i.exec(tag)?.[1]?.toLowerCase();
      expect(method, tag).toBe(GET_FORMS.has(file) ? "get" : "post");
    }
  });
});
