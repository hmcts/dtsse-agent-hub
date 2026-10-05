/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CredentialActions, CredentialSettingsView, CredentialsSection } from "@/components/credentials/CredentialSettingsView";
import type { CredentialStatus } from "@/credentials/store";
import type { CredentialSettings } from "@/web/data";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

function status(kind: CredentialStatus["kind"], overrides: Partial<CredentialStatus> = {}): CredentialStatus {
  return { kind, stored: false, accountLabel: null, updatedAt: null, updatedVia: null, ...overrides };
}

const NOTHING_STORED = [status("github"), status("azure"), status("claude"), status("bedrock")];

function actions(): CredentialActions {
  return { save: vi.fn(async () => ({ ok: true as const, confirmation: "Your GitHub token is stored" })), remove: vi.fn(async () => ({ ok: true as const })) };
}

function show(settings: CredentialSettings, given = actions()) {
  render(<CredentialSettingsView settings={settings} actions={given} />);
  return given;
}

function card(heading: string): HTMLElement {
  return screen.getByRole("heading", { name: heading }).closest("section") as HTMLElement;
}

describe("CredentialSettingsView", () => {
  it("should say the viewer is on Amazon Bedrock and offer no Claude token field when their route is Bedrock", () => {
    show({ available: true, modelRoute: "bedrock", statuses: NOTHING_STORED });

    expect(card("Model").textContent).toContain("Amazon Bedrock, with your Bedrock API key");
    expect(within(card("Claude token")).queryByRole("form")).toBeNull();
    expect(card("Claude token").textContent).toContain("Not needed");
    expect(screen.getByRole("form", { name: "Save GitHub token" })).toBeTruthy();
  });

  it("should offer a Claude token field when the viewer is on their own licence", () => {
    show({ available: true, modelRoute: "own-licence", statuses: NOTHING_STORED });

    expect(card("Model").textContent).toContain("Your own Claude licence");
    expect(screen.getByRole("form", { name: "Save Claude token" })).toBeTruthy();
  });

  it("should never offer to paste the Azure sign-in when it comes from the virtual agent", () => {
    show({ available: true, modelRoute: "own-licence", statuses: NOTHING_STORED });

    expect(within(card("Azure sign-in")).queryByRole("form")).toBeNull();
    expect(card("Azure sign-in").textContent).toContain("device-code");
  });

  it("should say each credential is not stored and offer no delete when nothing is stored", () => {
    show({ available: true, modelRoute: "bedrock", statuses: NOTHING_STORED });

    for (const heading of ["GitHub token", "Azure sign-in", "Claude token", "Bedrock API key"]) {
      expect(card(heading).textContent).toContain("Not stored");
    }
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("should show when and how a stored credential was saved and its account, but no value, when one is stored", () => {
    show({
      available: true,
      modelRoute: "bedrock",
      statuses: [
        status("github", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "cli" }),
        status("azure", { stored: true, accountLabel: "a.person@justice.gov.uk", updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "pod" }),
        status("claude")
      ]
    });

    const github = card("GitHub token");
    expect(github.textContent).toContain("Stored");
    expect(github.textContent).toContain("from the command line");
    expect(within(github).getByRole("form", { name: "Delete GitHub token" })).toBeTruthy();
    expect(within(github).getByLabelText("Replace your GitHub token")).toHaveProperty("type", "password");
    const azure = card("Azure sign-in");
    expect(azure.textContent).toContain("by your virtual agent");
    expect(azure.textContent).toContain("for a.person@justice.gov.uk");
    expect(within(azure).getByRole("form", { name: "Delete Azure sign-in" })).toBeTruthy();
  });

  it.each(["bedrock", "own-licence"] as const)("should offer a password field for the Bedrock API key when the route is %s", (modelRoute) => {
    show({ available: true, modelRoute, statuses: NOTHING_STORED });

    expect(within(card("Bedrock API key")).getByLabelText("Paste a Bedrock API key")).toHaveProperty("type", "password");
  });

  it("should show a stored Bedrock API key as stored with a delete and no value when one is stored", () => {
    show({ available: true, modelRoute: "bedrock", statuses: [status("bedrock", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "cli" })] });

    const bedrock = card("Bedrock API key");
    expect(bedrock.textContent).toContain("Stored");
    expect(bedrock.textContent).toContain("from the command line");
    expect(within(bedrock).getByRole("form", { name: "Delete Bedrock API key" })).toBeTruthy();
    expect(within(bedrock).getByLabelText("Replace your Bedrock API key")).toHaveProperty("value", "");
  });

  it("should say a stored credential was saved on this page when it came from the web", () => {
    show({ available: true, modelRoute: "bedrock", statuses: [status("github", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "web" })] });

    expect(card("GitHub token").textContent).toContain("on this page");
  });

  it("should send the kind and the pasted value to the save action and confirm when a token is saved", async () => {
    const given = show({ available: true, modelRoute: "bedrock", statuses: NOTHING_STORED });

    fireEvent.change(screen.getByLabelText("Paste a GitHub token"), { target: { value: "ghp_pasted" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save GitHub token" }));
    });

    const sent = (given.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FormData;
    expect(sent.get("kind")).toBe("github");
    expect(sent.get("value")).toBe("ghp_pasted");
    expect(screen.getByRole("status").textContent).toBe("Your GitHub token is stored");
  });

  it("should send the kind to the delete action when a stored credential is deleted", async () => {
    const given = show({ available: true, modelRoute: "bedrock", statuses: [status("azure", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z" })] });

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Delete Azure sign-in" }));
    });

    expect(((given.remove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FormData).get("kind")).toBe("azure");
  });

  it("should say credentials are unavailable, and why, with no forms when the deployment cannot store them", () => {
    show({ available: false, modelRoute: "bedrock", reason: "this deployment has no credentials vault" });

    expect(screen.getByText("Credentials unavailable")).toBeTruthy();
    expect(screen.getByText("this deployment has no credentials vault")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(card("Model")).toBeTruthy();
  });
});

describe("CredentialsSection", () => {
  it("should head the credentials as a section the virtual agents page links to when it is part of that page", () => {
    render(<CredentialsSection settings={{ available: true, modelRoute: "bedrock", statuses: NOTHING_STORED }} actions={actions()} />);

    const section = screen.getByRole("region", { name: "Credentials" });
    expect(section.id).toBe("credentials");
    expect(within(section).getByRole("heading", { level: 2, name: "Credentials" })).toBeTruthy();
    expect(within(section).getByRole("form", { name: "Save GitHub token" })).toBeTruthy();
  });
});

describe("the Jenkins API token card", () => {
  it("should say it is optional and link to where the token is made when the viewer's credentials are listed", () => {
    show({ available: true, modelRoute: "bedrock", statuses: [...NOTHING_STORED, status("jenkins")] });

    const jenkins = card("Jenkins API token");
    expect(jenkins.textContent).toContain("Optional");
    expect(within(jenkins).getByRole("link").getAttribute("href")).toBe("https://build.hmcts.net/me/configure");
    expect(within(jenkins).getByRole("form", { name: "Save Jenkins API token" })).toBeTruthy();
  });
});
