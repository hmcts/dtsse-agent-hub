/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelBuilder, typedTopic } from "@/components/channels/ChannelBuilder";

const pushed: string[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (target: string) => void pushed.push(target), refresh: () => undefined })
}));

beforeEach(() => {
  pushed.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ topics: [{ slug: "pcs-api", message_count: 3 }] })))
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function search(): HTMLInputElement {
  return screen.getByLabelText(/Topics/) as HTMLInputElement;
}

function addTyped(value: string): void {
  fireEvent.change(search(), { target: { value } });
  fireEvent.keyDown(search(), { key: "Enter" });
}

async function save(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Save channel" }));
  });
}

describe("typedTopic", () => {
  it("should normalise a typed slug and explain a value that is not one", () => {
    expect(typedTopic(" PCS-API ")).toEqual({ slug: "pcs-api" });
    expect(typedTopic("pcs api")).toMatchObject({ error: expect.stringContaining("is not a topic") });
  });
});

describe("ChannelBuilder", () => {
  it("should save the chosen topics, mode, name and sharing and open the channel when it is valid", async () => {
    const saveAction = vi.fn(async () => ({ ok: true as const, id: "channel-1" }));
    render(<ChannelBuilder save={saveAction} />);

    addTyped("pcs-api");
    addTyped("Database");
    fireEvent.click(screen.getByLabelText(/all of these topics/));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PCS data" } });
    fireEvent.click(screen.getByLabelText(/Share with everyone/));
    await save();

    expect(saveAction).toHaveBeenCalledWith({ name: "PCS data", topics: ["pcs-api", "database"], match: "all", shared: true });
    expect(pushed).toEqual(["/channels/channel-1"]);
  });

  it("should refuse to save and say why when no topic is chosen", async () => {
    const saveAction = vi.fn();
    render(<ChannelBuilder save={saveAction} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Empty" } });
    await save();

    expect(saveAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("between 1 and 10 topics");
  });

  it("should refuse to save when eleven topics are chosen", async () => {
    const saveAction = vi.fn();
    render(<ChannelBuilder save={saveAction} initialTopics={["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]} />);

    addTyped("k");
    await save();

    expect(saveAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("this one has 11");
  });

  it("should refuse to save without a name", async () => {
    const saveAction = vi.fn();
    render(<ChannelBuilder save={saveAction} initialTopics={["a"]} />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: " " } });
    await save();

    expect(saveAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("give the channel a name");
  });

  it("should explain a typed value that is not a slug and not add it", () => {
    render(<ChannelBuilder save={vi.fn()} />);

    addTyped("not a slug");

    expect(screen.getByText(/is not a topic/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect((screen.getByRole("button", { name: "Add topic" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("should start from a view's topics and mode when opened with them, and let a topic be removed", () => {
    render(<ChannelBuilder save={vi.fn()} initialTopics={["a", "b"]} initialMatch="all" />);

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("a + b");
    expect((screen.getByLabelText(/all of these topics/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Remove a" }));
    expect(screen.queryByRole("button", { name: "Remove a" })).toBeNull();
  });

  it("should offer suggested topics from the search and add one when it is clicked", async () => {
    render(<ChannelBuilder save={vi.fn()} />);

    fireEvent.change(search(), { target: { value: "pcs" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    fireEvent.click(screen.getByRole("button", { name: /#pcs-api/ }));

    expect(fetch).toHaveBeenCalledWith("/api/ui/topics?prefix=pcs", expect.anything());
    expect(screen.getByRole("button", { name: "Remove pcs-api" })).toBeTruthy();
  });

  it("should add a typed topic with the button", () => {
    render(<ChannelBuilder save={vi.fn()} />);

    fireEvent.change(search(), { target: { value: "ccd" } });
    fireEvent.click(screen.getByRole("button", { name: "Add topic" }));

    expect(screen.getByRole("button", { name: "Remove ccd" })).toBeTruthy();
  });

  it("should show the server's refusal when saving is refused", async () => {
    render(<ChannelBuilder save={vi.fn(async () => ({ ok: false as const, error: "your session has ended" }))} initialTopics={["a"]} />);

    await save();

    expect(screen.getByRole("alert").textContent).toContain("session has ended");
  });

  it("should say the channel was not saved when the call fails", async () => {
    render(
      <ChannelBuilder
        save={vi.fn(async () => {
          throw new Error("offline");
        })}
        initialTopics={["a"]}
      />
    );

    await save();

    expect(screen.getByRole("alert").textContent).toContain("could not be saved");
  });

  it("should save a channel matching any topic when all is switched back to any", async () => {
    const saveAction = vi.fn(async () => ({ ok: true as const, id: "channel-1" }));
    render(<ChannelBuilder save={saveAction} initialTopics={["a", "b"]} initialMatch="all" />);

    fireEvent.click(screen.getByLabelText(/any of these topics/));
    await save();

    expect(saveAction).toHaveBeenCalledWith(expect.objectContaining({ match: "any" }));
  });

  it("should offer no suggestions and keep working when the topic lookup fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );
    render(<ChannelBuilder save={vi.fn()} />);

    fireEvent.change(search(), { target: { value: "pcs" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(fetch).toHaveBeenCalled();
    expect(screen.queryByRole("list", { name: "Suggested topics" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add topic" })).toBeTruthy();
  });
});
