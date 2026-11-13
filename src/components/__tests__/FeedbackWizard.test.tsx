/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedbackWizard, type WizardActions } from "@/components/feedback/dev/FeedbackWizard";
import type { ProbeOutcome } from "@/feedback/probe";
import { project } from "./feedback-fixtures";

const PASS: ProbeOutcome = { result: "pass", status: 200, reason: "it answered 200" };

let probe: ReturnType<typeof vi.fn>;
let create: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

function actions(): WizardActions {
  return { probe, create } as unknown as WizardActions;
}

beforeEach(() => {
  probe = vi.fn().mockResolvedValue({ ok: true, probe: PASS });
  create = vi.fn().mockResolvedValue({ ok: true, project: project() });
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ people: [{ oid: "mo", name: "Mo Member", email: "mo@example.com" }] }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function heading(): string {
  return screen.getByRole("heading", { level: 2 }).textContent ?? "";
}

async function next(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
  });
}

async function toLinks(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  Apply for a thing " } });
  await next();
}

async function fillLink(index: number, label: string, url: string): Promise<void> {
  const row = screen.getByRole("group", { name: `Link ${index}` });
  fireEvent.change(within(row).getByLabelText("Label"), { target: { value: label } });
  const field = within(row).getByLabelText("Prototype address");
  fireEvent.change(field, { target: { value: url } });
  await act(async () => {
    fireEvent.blur(field);
  });
}

describe("FeedbackWizard", () => {
  it("should not leave the name step without a name, and say why", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);

    await next();

    expect(heading()).toBe("Step 1 of 5: Name");
    expect(screen.getByRole("alert").textContent).toBe("Give the project a name");
  });

  it("should check a link's address as it is entered, and show the answer beside it", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();

    expect(heading()).toBe("Step 2 of 5: Links");
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 2 }));
    await fillLink(1, "Round 1", "https://proto.example.com/start");

    expect(probe).toHaveBeenCalledWith({ url: "https://proto.example.com/start" });
    expect(screen.getByText(/The prototype answered: it answered 200/)).toBeTruthy();
  });

  it("should refuse an address that is not https before asking the hub about it", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "http://proto.example.com");

    expect(screen.getByText("The address must start https://")).toBeTruthy();
    await next();

    expect(probe).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Link 1: Enter the prototype's address, starting https://");
  });

  it("should not go past an address the hub refuses, whatever is pressed", async () => {
    probe.mockResolvedValue({ ok: true, probe: { result: "refused", reason: "the address must be on the public internet" } });
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://intranet.example.com");

    await next();
    await next();

    expect(heading()).toBe("Step 2 of 5: Links");
    expect(screen.getByRole("alert").textContent).toBe("Link 1 cannot be used: the address must be on the public internet.");
  });

  it("should warn of a prototype it could not reach, and carry on when Next is pressed again", async () => {
    probe.mockResolvedValue({ ok: true, probe: { result: "warn", status: null, reason: "it could not be reached from the hub" } });
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com");

    await next();
    expect(screen.getByRole("alert").textContent).toContain("may not work: it could not be reached from the hub");
    await next();

    expect(heading()).toBe("Step 3 of 5: Team");
  });

  it("should treat a probe the hub could not answer as a warning", async () => {
    probe.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com");

    expect(screen.getByText(/Could not confirm the prototype/)).toBeTruthy();
  });

  it("should add and remove link rows, and create the project with all of them, the team and the settings", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com/start");
    fireEvent.click(screen.getByRole("button", { name: "Add another link" }));
    fireEvent.click(screen.getByRole("button", { name: "Add another link" }));
    await fillLink(2, "Round 2", "https://proto2.example.com/");
    fireEvent.change(within(screen.getByRole("group", { name: "Link 2" })).getByLabelText("Prototype version (optional)"), { target: { value: " v4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Remove link 3" }));
    await next();

    expect(heading()).toBe("Step 3 of 5: Team");
    vi.useFakeTimers();
    fireEvent.change(screen.getByRole("combobox", { name: "Team members" }), { target: { value: "Mo" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    vi.useRealTimers();
    fireEvent.click(screen.getByRole("option", { name: /Mo Member/ }));
    fireEvent.click(screen.getByLabelText(/Hide what reviewers type/));
    fireEvent.change(screen.getByLabelText(/Keep comments and recordings for/), { target: { value: "30" } });
    await next();

    expect(heading()).toBe("Step 4 of 5: Review and create");
    expect(screen.getByText("Mo Member")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    });

    expect(create).toHaveBeenCalledWith({
      name: "Apply for a thing",
      links: [
        { label: "Round 1", url: "https://proto.example.com/start" },
        { label: "Round 2", url: "https://proto2.example.com/", prototype_version: "v4" }
      ],
      member_oids: ["mo"],
      mask_inputs: true,
      retention_days: 30
    });
    expect(heading()).toBe("Step 5 of 5: Share");
  });

  it("should keep the person's answers and say why when creating is refused", async () => {
    create.mockResolvedValue({ ok: false, error: "someone named has not used the hub yet, so cannot be added" });
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com/start");
    await next();
    await next();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    });

    expect(heading()).toBe("Step 4 of 5: Review and create");
    expect(screen.getByRole("alert").textContent).toBe("someone named has not used the hub yet, so cannot be added");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByDisplayValue("Round 1")).toBeTruthy();
  });

  it("should refuse a retention outside 1 to 365 days", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com/start");
    await next();
    fireEvent.change(screen.getByLabelText(/Keep comments and recordings for/), { target: { value: "400" } });
    await next();

    expect(screen.getByRole("alert").textContent).toBe("Keep comments and recordings for between 1 and 365 days");
  });

  it("should end with each link's share address to copy and open, and the way to the project", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com/start");
    await next();
    await next();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    });

    const share = screen.getByLabelText("Share link for Round 1") as HTMLInputElement;
    expect(share.value).toBe("https://hub.example.com/review/tok-one");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Share link for Round 1" }));
    });
    expect(writeText).toHaveBeenCalledWith("https://hub.example.com/review/tok-one");
    expect(screen.getByRole("button", { name: "Copied Share link for Round 1" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Open/ }).getAttribute("href")).toBe("https://hub.example.com/review/tok-one");
    expect(screen.getByRole("link", { name: "Go to project" }).getAttribute("href")).toBe("/assistant/feedback/p1");
  });

  it("should select the address to copy by hand when the clipboard is refused", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    await toLinks();
    await fillLink(1, "Round 1", "https://proto.example.com/start");
    await next();
    await next();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    });
    const share = screen.getByLabelText("Share link for Round 1") as HTMLInputElement;
    const select = vi.spyOn(share, "select");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy Share link for Round 1" }));
    });

    expect(select).toHaveBeenCalled();
  });

  it("should check the length of what it is given", async () => {
    render(<FeedbackWizard actions={actions()} origin="https://hub.example.com" />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "x".repeat(121) } });
    await next();
    expect(screen.getByRole("alert").textContent).toBe("Keep the name to 120 characters");
    await toLinks();

    await fillLink(1, "", "https://proto.example.com");
    await next();
    expect(screen.getByRole("alert").textContent).toContain("Give the link a label");
    await fillLink(1, "x".repeat(81), "https://proto.example.com");
    await next();
    expect(screen.getByRole("alert").textContent).toContain("Keep the label to 80 characters");
    await fillLink(1, "ok", "https://proto.example.com");
    fireEvent.change(screen.getByLabelText("Prototype version (optional)"), { target: { value: "v".repeat(101) } });
    await next();
    expect(screen.getByRole("alert").textContent).toContain("Keep the version to 100 characters");
  });
});
