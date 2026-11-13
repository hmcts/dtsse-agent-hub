/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentionInput, matchingPeople, mentionQuery } from "@/components/feedback/MentionInput";
import { mentionRuns, ThreadCard } from "@/components/feedback/ThreadCard";
import type { FeedbackThreadView } from "@/feedback/thread-store";

const PEOPLE = [
  { oid: "o1", name: "Ann Lee" },
  { oid: "o2", name: "Bob Builder" },
  { oid: "o3", name: "Annabel Smith" }
];

afterEach(() => {
  cleanup();
});

describe("mentionQuery", () => {
  it.each([
    ["@Ann", 4, { start: 0, query: "Ann" }],
    ["Hi @Bob B", 9, { start: 3, query: "Bob B" }],
    ["Hi @", 4, { start: 3, query: "" }]
  ])("should read the mention being typed in %j", (text, caret, expected) => {
    expect(mentionQuery(text, caret)).toEqual(expected);
  });

  it.each([
    ["no @", "Hello", 5],
    ["an address", "ann@example", 11],
    ["a space straight after @", "@ x", 3],
    ["a new line", "@Ann\nx", 6]
  ])("should read nothing for %s", (_label, text, caret) => {
    expect(mentionQuery(text, caret)).toBeUndefined();
  });
});

describe("matchingPeople", () => {
  it("should match the start of the name or of any word in it", () => {
    expect(matchingPeople(PEOPLE, "ann").map((person) => person.oid)).toEqual(["o1", "o3"]);
    expect(matchingPeople(PEOPLE, "build").map((person) => person.oid)).toEqual(["o2"]);
  });
});

describe("mentionRuns", () => {
  it("should pick out the names, the longest first, and nothing inside a word", () => {
    expect(mentionRuns("Ask @Ann Lee and @ann, not x@Ann Lee", ["Ann", "Ann Lee"])).toEqual([
      { text: "Ask ", mention: false },
      { text: "@Ann Lee", mention: true },
      { text: " and ", mention: false },
      { text: "@ann", mention: true },
      { text: ", not x@Ann Lee", mention: false }
    ]);
  });

  it("should leave the body whole when it names nobody", () => {
    expect(mentionRuns("Hello", [])).toEqual([{ text: "Hello", mention: false }]);
  });
});

function Box({ onSubmit = vi.fn() }: { onSubmit?: () => void }) {
  const [value, setValue] = useState("");
  return <MentionInput value={value} onChange={setValue} people={PEOPLE} label="Comment" onSubmit={onSubmit} />;
}

function type(box: HTMLElement, value: string): void {
  fireEvent.change(box, { target: { value, selectionStart: value.length } });
}

describe("MentionInput", () => {
  it("should offer people as an @ is typed, and write the chosen name out", async () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
    render(<Box />);
    const box = screen.getByRole("combobox", { name: "Comment" }) as HTMLTextAreaElement;
    type(box, "Hi @an");
    expect(box.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Ann Lee", "Annabel Smith"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("Hi @Ann Lee ");
    expect(box.getAttribute("aria-expanded")).toBe("false");
    vi.unstubAllGlobals();
  });

  it("should choose with the mouse too", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
    render(<Box />);
    const box = screen.getByRole("combobox", { name: "Comment" }) as HTMLTextAreaElement;
    type(box, "@bo");
    fireEvent.mouseDown(screen.getByRole("option", { name: "Bob Builder" }));
    expect(box.value).toBe("@Bob Builder ");
    vi.unstubAllGlobals();
  });

  it("should close the list on Escape and submit on Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<Box onSubmit={onSubmit} />);
    const box = screen.getByRole("combobox", { name: "Comment" });
    type(box, "@b");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(onSubmit).toHaveBeenCalled();
  });

  it("should hand its element to a ref object or function", () => {
    const object = { current: null as HTMLTextAreaElement | null };
    const callback = vi.fn();
    render(
      <>
        <MentionInput value="" onChange={vi.fn()} people={[]} label="A" inputRef={object} />
        <MentionInput value="" onChange={vi.fn()} people={[]} label="B" inputRef={callback} />
      </>
    );
    expect(object.current).toBe(screen.getByRole("combobox", { name: "A" }));
    expect(callback).toHaveBeenCalledWith(screen.getByRole("combobox", { name: "B" }));
  });
});

function thread(overrides: Partial<FeedbackThreadView> = {}): FeedbackThreadView {
  return {
    id: "t1",
    projectId: "p",
    linkId: "l",
    pagePath: "/start",
    anchor: { selector: "#a", text: "", tag: "a", rect: { x: 0, y: 0, width: 1, height: 1 }, viewport: { width: 1, height: 1 } },
    status: "open",
    author: { oid: "o2", name: "Bob Builder" },
    resolvedBy: null,
    resolvedAt: null,
    snapshotBlob: null,
    recordingId: null,
    offsetMs: null,
    prototypeVersion: null,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    comments: [
      { id: "c1", author: { oid: "o2", name: "Bob Builder" }, body: "Ask @Ann Lee", createdAt: "2026-11-13T10:00:00.000Z", mentions: ["o1"] },
      { id: "c2", author: { oid: "o1", name: "Ann Lee" }, body: "Will do", createdAt: "2026-11-13T10:05:00.000Z", mentions: [] }
    ],
    ...overrides
  };
}

describe("ThreadCard", () => {
  it("should show the author, the comments and the people named", () => {
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={vi.fn()} onStatus={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Bob Builder" })).toBeTruthy();
    expect(screen.getByText("@Ann Lee").tagName).toBe("STRONG");
    expect(screen.getByText("Will do")).toBeTruthy();
  });

  it("should show a reply's error and keep the draft", async () => {
    const onReply = vi.fn(async () => "That is a lot at once");
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={onReply} onStatus={vi.fn()} />);
    const box = screen.getByRole("combobox", { name: "Reply to Bob Builder" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    });
    expect(onReply).toHaveBeenCalledWith("Thanks");
    expect(screen.getByRole("alert").textContent).toBe("That is a lot at once");
    expect(box.value).toBe("Thanks");
  });

  it("should clear the draft once a reply is saved", async () => {
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={vi.fn(async () => null)} onStatus={vi.fn()} />);
    const box = screen.getByRole("combobox", { name: "Reply to Bob Builder" }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Thanks" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    expect(box.value).toBe("");
  });

  it("should reopen a resolved thread and say who resolved it", async () => {
    const onStatus = vi.fn(async () => null);
    render(
      <ThreadCard
        thread={thread({ status: "resolved", resolvedBy: { oid: "o1", name: "Ann Lee" } })}
        people={PEOPLE}
        onReply={vi.fn()}
        onStatus={onStatus}
        number={3}
        focused
      />
    );
    expect(screen.getByRole("heading", { name: "Comment 3: Bob Builder" })).toBeTruthy();
    expect(screen.getByText(/by Ann Lee/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    });
    expect(onStatus).toHaveBeenCalledWith("open");
  });

  it("should say when its element is not on the page", () => {
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={vi.fn()} onStatus={vi.fn()} missing />);
    expect(screen.getByText(/not on the page as it is now/)).toBeTruthy();
  });

  it("should tell the page when focus comes into it", () => {
    const onFocus = vi.fn();
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={vi.fn()} onStatus={vi.fn()} onFocus={onFocus} />);
    fireEvent.focus(screen.getByRole("button", { name: "Resolve" }));
    expect(onFocus).toHaveBeenCalled();
  });

  it("should tell the page when its heading is chosen without moving focus, as Safari's clicks do", () => {
    const onFocus = vi.fn();
    render(<ThreadCard thread={thread()} people={PEOPLE} onReply={vi.fn()} onStatus={vi.fn()} onFocus={onFocus} number={3} />);
    const heading = screen.getByRole("heading", { name: "Comment 3: Bob Builder" });
    fireEvent.click(screen.getByRole("button", { name: "Comment 3: Bob Builder" }));
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(heading.contains(screen.getByRole("button", { name: "Comment 3: Bob Builder" }))).toBe(true);
    expect(screen.getByRole("article", { name: "Comment 3: Bob Builder" })).toBeTruthy();
  });
});
