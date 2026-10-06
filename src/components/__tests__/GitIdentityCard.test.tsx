/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type GitIdentityActions, GitIdentityCard } from "@/components/credentials/GitIdentityCard";
import type { GitIdentitySettings } from "@/web/data";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

afterEach(() => {
  cleanup();
  refresh.mockReset();
});

const NOTHING: GitIdentitySettings = { available: true, stored: false, identity: {} };
const STORED: GitIdentitySettings = { available: true, stored: true, identity: { name: "Olive Owner", email: "olive@example.com" } };

function actions(): GitIdentityActions {
  return {
    save: vi.fn(async () => ({ ok: true as const, confirmation: "Your git identity is saved" })),
    clear: vi.fn(async () => ({ ok: true as const, confirmation: "Your virtual agents are back to the default git identity" }))
  };
}

function show(settings: GitIdentitySettings, given = actions()) {
  const view = render(<GitIdentityCard settings={settings} actions={given} />);
  return { given, rerender: (next: GitIdentitySettings) => view.rerender(<GitIdentityCard settings={next} actions={given} />) };
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("GitIdentityCard", () => {
  it("should explain the default and offer empty fields and no clear when nothing is stored", () => {
    show(NOTHING);

    expect(screen.getByRole("heading", { name: "Git identity" })).toBeTruthy();
    expect(screen.getByText("Default")).toBeTruthy();
    expect(
      screen.getByText(
        "Commits from your virtual agents use your HMCTS email if it's on your GitHub account, otherwise your GitHub noreply address. Set these to override."
      )
    ).toBeTruthy();
    expect(field("Name").value).toBe("");
    expect(field("Email").value).toBe("");
    expect(field("Email").type).toBe("email");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("should fill the fields and offer a clear when an override is stored", () => {
    show(STORED);

    expect(screen.getByText("Overridden")).toBeTruthy();
    expect(field("Name").value).toBe("Olive Owner");
    expect(field("Email").value).toBe("olive@example.com");
    expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
  });

  it("should send both fields to the save action and confirm when Save is pressed", async () => {
    const { given } = show(NOTHING);
    fireEvent.change(field("Name"), { target: { value: "O. Owner" } });
    fireEvent.change(field("Email"), { target: { value: "o@example.com" } });

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your git identity" }));
    });

    const form = vi.mocked(given.save).mock.calls[0]?.[0] as FormData;
    expect(form.get("name")).toBe("O. Owner");
    expect(form.get("email")).toBe("o@example.com");
    expect(screen.getByRole("status").textContent).toBe("Your git identity is saved");
    expect(field("Name").value).toBe("O. Owner");
    expect(refresh).toHaveBeenCalled();
  });

  it("should show the refusal when the save action refuses", async () => {
    const given = actions();
    given.save = vi.fn(async () => ({ ok: false as const, error: "that is not an email address" }));
    show(NOTHING, given);

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Save your git identity" }));
    });

    expect(screen.getByRole("alert").textContent).toBe("that is not an email address");
  });

  it("should call the clear action and empty the fields when the override is cleared", async () => {
    const { given, rerender } = show(STORED);

    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Clear your git identity" }));
    });
    expect(given.clear).toHaveBeenCalledTimes(1);
    rerender(NOTHING);

    expect(field("Name").value).toBe("");
    expect(field("Email").value).toBe("");
  });

  it("should say why when the credential store is unavailable", () => {
    show({ available: false, reason: "Key Vault is not configured" });

    expect(screen.getByText("Your git identity is unavailable")).toBeTruthy();
    expect(screen.getByText("Key Vault is not configured")).toBeTruthy();
    expect(screen.queryByRole("form")).toBeNull();
  });
});
