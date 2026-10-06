/**
 * @vitest-environment jsdom
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionForm } from "@/components/ActionForm";
import { ClaudeMdSection } from "@/components/credentials/ClaudeMdSection";
import { CredentialSettingsView } from "@/components/credentials/CredentialSettingsView";
import { OnboardingChecklist } from "@/components/virtual-agents/OnboardingChecklist";
import type { CredentialStatus } from "@/credentials/store";
import type { LoginView } from "@/virtual-agents/logins";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/components/live/HubStream", () => ({ useEndSession: () => () => undefined }));

afterEach(() => {
  cleanup();
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const SECRET_NAMES = new Set(["value", "code", "token", "password", "secret"]);

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function stored(kind: CredentialStatus["kind"]): CredentialStatus {
  return { kind, stored: true, accountLabel: null, updatedAt: "2026-10-05T11:00:00.000Z", updatedVia: "web" };
}

function missing(kind: CredentialStatus["kind"]): CredentialStatus {
  return { kind, stored: false, accountLabel: null, updatedAt: null, updatedVia: null };
}

function pasteLogin(kind: LoginView["kind"]): LoginView {
  return {
    kind,
    prompt: "paste_code",
    userCode: null,
    verificationUri: "https://claude.ai/oauth/authorize?x=1",
    expiresAt: "2026-10-05T12:10:00.000Z",
    state: "pending",
    codeWaiting: false
  };
}

/** Where a browser goes when the form is submitted natively, with no script to intercept it. */
function nativeSubmitUrl(form: HTMLFormElement): string {
  const target = new URL(form.getAttribute("action") || "/agents/va-1", "https://agent-hub.example");
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
    expect(nativeSubmitUrl(form)).toBe("https://agent-hub.example/agents/va-1");
  });

  it("should post every sign-in form on the virtual agent page when keys are missing and a code is waiting to be pasted", () => {
    const { container } = render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        needed={["github", "claude", "bedrock"]}
        optional={["jenkins"]}
        statuses={[]}
        logins={[pasteLogin("claude")]}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={NOW}
      />
    );
    fill(container);

    expect([...container.querySelectorAll("form")].filter(carriesSecret).map((form) => form.getAttribute("aria-label"))).toEqual([
      "Paste the Claude code",
      "Save your Bedrock API key",
      "Save your Jenkins API token"
    ]);
    expectEveryFormPosts(container);
    expectSecretInputsHidden(container);
    for (const form of container.querySelectorAll("form")) {
      expect(nativeSubmitUrl(form)).not.toContain("11a2b3c4d5e6f708192a3b4c5d");
    }
  });

  it("should post the replace and reconnect forms when the pencil and reconnect buttons open them", () => {
    const { container } = render(
      <OnboardingChecklist
        virtualAgentId="va-1"
        desired="running"
        needed={["github", "bedrock"]}
        optional={["jenkins"]}
        statuses={[stored("github"), stored("bedrock"), stored("jenkins")]}
        logins={[]}
        paste={ok()}
        save={ok()}
        reconnect={ok()}
        now={NOW}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Replace your Jenkins API token" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace your Bedrock API key" }));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));

    expect(screen.getByRole("form", { name: "Save your Jenkins API token" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Reconnect GitHub" })).toBeTruthy();
    expectEveryFormPosts(container);
    expectSecretInputsHidden(container);
  });

  it("should post every form on the credentials page whatever is stored", () => {
    const kinds: CredentialStatus["kind"][] = ["github", "azure", "claude", "bedrock", "jenkins", "atlassian"];
    for (const statuses of [kinds.map(missing), kinds.map(stored)]) {
      const { container, unmount } = render(
        <CredentialSettingsView settings={{ available: true, modelRoute: "own-licence", statuses }} actions={{ save: ok(), remove: ok() }} />
      );

      expectEveryFormPosts(container);
      expectSecretInputsHidden(container);
      unmount();
    }
  });

  it("should post the CLAUDE.md save and reset forms", () => {
    const { container } = render(
      <ClaudeMdSection
        settings={{ available: true, stored: true, text: "# Me", updatedAt: "2026-10-05T09:00:00.000Z" }}
        actions={{ save: ok(), reset: ok() }}
      />
    );

    expect(container.querySelectorAll("form")).toHaveLength(2);
    expectEveryFormPosts(container);
  });
});

/** The topic searches, whose one field is the search itself and belongs in a shareable URL. */
const GET_FORMS = new Set(["src/app/topics/page.tsx", "src/components/Sidebar.tsx"]);

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
