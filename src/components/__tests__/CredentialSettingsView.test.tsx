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
  it.each([
    "gateway",
    "bedrock"
  ] as const)("should say the viewer is on HMCTS Claude Code access and offer no Claude token field when no agent of theirs wants one on the %s route", (modelRoute) => {
    show({ available: true, modelRoute, claudeTokenUsable: false, statuses: NOTHING_STORED });

    expect(card("Model").textContent).toContain("HMCTS AI Gateway, on your own Azure sign-in");
    expect(within(card("Claude token")).queryByRole("form")).toBeNull();
    expect(card("Claude token").textContent).toContain("Not needed");
    expect(screen.getByRole("form", { name: "Save GitHub token" })).toBeTruthy();
  });

  // The key is an administrator's to paste here. This page is the one surface that offers it, so the box stays for
  // an agent created before the gateway route, and the Assistant never asks because no route of its own names it.
  it("should still offer the Amazon Bedrock API key box when the viewer is on the gateway route", () => {
    show({ available: true, modelRoute: "gateway", claudeTokenUsable: false, statuses: NOTHING_STORED });

    expect(within(card("Amazon Bedrock API key")).getByLabelText("Paste your Amazon Bedrock API key")).toHaveProperty("type", "password");
  });

  it("should offer a Claude token field when the viewer is on their own licence", () => {
    show({ available: true, modelRoute: "own-licence", claudeTokenUsable: true, statuses: NOTHING_STORED });

    expect(card("Model").textContent).toContain("Your own Claude licence");
    expect(screen.getByRole("form", { name: "Save Claude token" })).toBeTruthy();
  });

  // A person given the `AIGateway.User` app role after an agent of theirs was created is on the gateway while that
  // agent is still on their own licence and still waiting for a Claude token. Keyed off the route alone, this page
  // told them the token was not needed and gave them no box to paste it into.
  it("should offer a Claude token field and name both routes when the viewer is on the gateway and an agent of theirs is not", () => {
    show({ available: true, modelRoute: "gateway", claudeTokenUsable: true, statuses: NOTHING_STORED });

    expect(card("Model").textContent).toContain("HMCTS Claude Code access");
    expect(card("Model").textContent).toContain("own Claude licence");
    expect(card("Claude token").textContent).not.toContain("Not needed");
    expect(screen.getByRole("form", { name: "Save Claude token" })).toBeTruthy();
    expect(within(card("Amazon Bedrock API key")).getByLabelText("Paste your Amazon Bedrock API key")).toBeTruthy();
  });

  it("should never offer to paste the Azure sign-in when it comes from the virtual agent", () => {
    show({ available: true, modelRoute: "own-licence", claudeTokenUsable: true, statuses: NOTHING_STORED });

    expect(within(card("Azure sign-in")).queryByRole("form")).toBeNull();
    expect(card("Azure sign-in").textContent).toContain("device-code");
  });

  it("should say each credential is not stored and offer no delete when nothing is stored", () => {
    show({ available: true, modelRoute: "bedrock", claudeTokenUsable: false, statuses: NOTHING_STORED });

    for (const heading of ["GitHub token", "Azure sign-in", "Claude token", "Amazon Bedrock API key"]) {
      expect(card(heading).textContent).toContain("Not stored");
    }
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("should show when and how a stored credential was saved and its account, but no value, when one is stored", () => {
    show({
      available: true,
      modelRoute: "bedrock",
      claudeTokenUsable: false,
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

  it.each(["bedrock", "gateway", "own-licence"] as const)("should offer a password field for the Amazon Bedrock API key when the route is %s", (modelRoute) => {
    show({
      available: true,
      modelRoute,
      claudeTokenUsable: modelRoute === "own-licence",
      statuses: NOTHING_STORED
    });

    expect(within(card("Amazon Bedrock API key")).getByLabelText("Paste your Amazon Bedrock API key")).toHaveProperty("type", "password");
  });

  it("should show a stored Amazon Bedrock API key as stored with a delete and no value when one is stored", () => {
    show({
      available: true,
      modelRoute: "bedrock",
      claudeTokenUsable: false,
      statuses: [status("bedrock", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "cli" })]
    });

    const bedrock = card("Amazon Bedrock API key");
    expect(bedrock.textContent).toContain("Stored");
    expect(bedrock.textContent).toContain("from the command line");
    expect(within(bedrock).getByRole("form", { name: "Delete Amazon Bedrock API key" })).toBeTruthy();
    expect(within(bedrock).getByLabelText("Replace your Amazon Bedrock API key")).toHaveProperty("value", "");
  });

  it("should say a stored credential was saved on this page when it came from the web", () => {
    show({
      available: true,
      modelRoute: "bedrock",
      claudeTokenUsable: false,
      statuses: [status("github", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z", updatedVia: "web" })]
    });

    expect(card("GitHub token").textContent).toContain("on this page");
  });

  it("should send the kind and the pasted value to the save action and confirm when a token is saved", async () => {
    const given = show({ available: true, modelRoute: "bedrock", claudeTokenUsable: false, statuses: NOTHING_STORED });

    fireEvent.change(screen.getByLabelText("Paste your GitHub token"), { target: { value: "ghp_pasted" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save GitHub token" }));
    });

    const sent = (given.save as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FormData;
    expect(sent.get("kind")).toBe("github");
    expect(sent.get("value")).toBe("ghp_pasted");
    expect(screen.getByRole("status").textContent).toBe("Your GitHub token is stored");
  });

  it("should send the kind to the delete action when a stored credential is deleted", async () => {
    const given = show({
      available: true,
      modelRoute: "bedrock",
      claudeTokenUsable: false,
      statuses: [status("azure", { stored: true, updatedAt: "2026-10-05T09:00:00.000Z" })]
    });

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Delete Azure sign-in" }));
    });

    expect(((given.remove as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as FormData).get("kind")).toBe("azure");
  });

  it("should say credentials are unavailable, and why, with no forms when the deployment cannot store them", () => {
    show({ available: false, modelRoute: "bedrock", claudeTokenUsable: false, reason: "this deployment has no credentials vault" });

    expect(screen.getByText("Credentials unavailable")).toBeTruthy();
    expect(screen.getByText("this deployment has no credentials vault")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
    expect(card("Model")).toBeTruthy();
  });
});

describe("CredentialsSection", () => {
  it("should head the credentials as a section the virtual agents page links to when it is part of that page", () => {
    render(
      <CredentialsSection settings={{ available: true, modelRoute: "bedrock", claudeTokenUsable: false, statuses: NOTHING_STORED }} actions={actions()} />
    );

    const section = screen.getByRole("region", { name: "Credentials" });
    expect(section.id).toBe("credentials");
    expect(within(section).getByRole("heading", { level: 2, name: "Credentials" })).toBeTruthy();
    expect(within(section).getByRole("form", { name: "Save GitHub token" })).toBeTruthy();
  });
});

describe("the Jenkins API token card", () => {
  it("should say it is optional and link to where the token is made when the viewer's credentials are listed", () => {
    show({ available: true, modelRoute: "bedrock", claudeTokenUsable: false, statuses: [...NOTHING_STORED, status("jenkins")] });

    const jenkins = card("Jenkins API token");
    expect(jenkins.textContent).toContain("Optional");
    expect(within(jenkins).getByRole("link").getAttribute("href")).toBe("https://build.hmcts.net/me/configure");
    expect(within(jenkins).getByRole("form", { name: "Save Jenkins API token" })).toBeTruthy();
  });
});

describe("the Atlassian sign-in card", () => {
  it("should say it is optional and never offer to paste it when it comes from the virtual agent", () => {
    show({ available: true, modelRoute: "bedrock", claudeTokenUsable: false, statuses: [...NOTHING_STORED, status("atlassian")] });

    const atlassian = card("Atlassian sign-in (Jira & Confluence)");
    expect(atlassian.textContent).toContain("Optional");
    expect(atlassian.textContent).toContain("device-code");
    expect(within(atlassian).getByRole("link").getAttribute("href")).toBe("https://hmcts.atlassian.net");
    expect(within(atlassian).queryByRole("form")).toBeNull();
  });

  it("should name the account and offer only to delete it when it is stored", () => {
    show({
      available: true,
      modelRoute: "bedrock",
      claudeTokenUsable: false,
      statuses: [
        ...NOTHING_STORED,
        status("atlassian", { stored: true, accountLabel: "alice@justice.gov.uk", updatedAt: "2026-10-05T11:00:00.000Z", updatedVia: "pod" })
      ]
    });

    const atlassian = card("Atlassian sign-in (Jira & Confluence)");
    expect(atlassian.textContent).toContain("for alice@justice.gov.uk");
    expect(
      within(atlassian)
        .getAllByRole("form")
        .map((form) => form.getAttribute("aria-label"))
    ).toEqual(["Delete Atlassian sign-in (Jira & Confluence)"]);
  });
});
