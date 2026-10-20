/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/agents/skills";
import { DirectComposer, type SendAction } from "@/components/agents/DirectComposer";
import { draftKey } from "@/components/agents/useDirectDraft";
import type { ThreadMessage } from "@/messages/direct-thread";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const AGENT = "11111111-1111-1111-1111-111111111111";
const OTHER_AGENT = "22222222-2222-2222-2222-222222222222";
const VIRTUAL_AGENT = "33333333-3333-3333-3333-333333333333";
const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER_VIEWER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

const SKILLS: Skill[] = [
  { name: "cft-explain", description: "Answer a what is X question" },
  { name: "cft-how-to", description: "Find a how-to recipe" },
  { name: "pcs:start-env", description: "Start an environment out of hours" },
  { name: "repo-sync", description: "Fast-forward cloned repos; explain what was skipped" }
];

const SENT: ThreadMessage = {
  id: "9",
  kind: "direct",
  title: null,
  body: "sent",
  topics: [],
  in_reply_to: null,
  target_agent_id: AGENT,
  created_at: "2026-10-06T09:00:00.000Z",
  author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
  delivery: "queued"
};

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function composer(
  skills: Skill[] = SKILLS,
  send: SendAction = vi.fn(async () => ({ ok: true as const, message: SENT })),
  overrides: Partial<React.ComponentProps<typeof DirectComposer>> = {}
) {
  render(
    <DirectComposer
      agentId={AGENT}
      agentName="pcs"
      viewerOid={VIEWER}
      status="idle"
      access="owner"
      skills={skills}
      send={send}
      onSent={vi.fn()}
      {...overrides}
    />
  );
  return send;
}

function field(): HTMLTextAreaElement {
  return screen.getByRole("combobox", { name: "Message this agent" }) as HTMLTextAreaElement;
}

function type(value: string): void {
  fireEvent.change(field(), { target: { value } });
}

function options(): string[] {
  return screen.queryAllByRole("option").map((option) => option.querySelector(".font-mono")?.textContent ?? "");
}

function activeOption(): string | null {
  const id = field().getAttribute("aria-activedescendant");
  return id === null ? null : (document.getElementById(id)?.querySelector(".font-mono")?.textContent ?? null);
}

describe("DirectComposer skill autocomplete", () => {
  it("should list every skill when the message is a bare slash", () => {
    composer();

    type("/");

    expect(field().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
    expect(options()).toEqual(["/cft-explain", "/cft-how-to", "/pcs:start-env", "/repo-sync"]);
    expect(activeOption()).toBe("/cft-explain");
  });

  it("should list name-prefix matches before description matches when a query is typed", () => {
    composer();

    type("/expl");

    expect(options()).toEqual(["/repo-sync"]);
    type("/cft-ex");
    expect(options()).toEqual(["/cft-explain"]);
    type("/EXPLAIN");
    expect(options()).toEqual(["/repo-sync"]);
  });

  it("should put a name match first when the query matches one name and another's description", () => {
    composer([
      { name: "find", description: "Search" },
      { name: "search", description: "Look things up" }
    ]);

    type("/search");

    expect(options()).toEqual(["/search", "/find"]);
  });

  it("should show nothing when the slash does not start the message", () => {
    composer();

    type("please /cft");

    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("should close the list when the caret moves past the leading token", () => {
    composer();

    type("/cft and more");

    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("should show nothing when no skill matches", () => {
    composer();

    type("/zzz");

    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("should move the active option with the arrow keys, wrapping at either end", () => {
    composer();
    type("/cft");

    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toBe("/cft-how-to");
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    expect(activeOption()).toBe("/cft-explain");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(activeOption()).toBe("/cft-how-to");
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("aria-selected"))).toEqual(["false", "true"]);
  });

  it("should pick the active skill and not send when Enter is pressed while the list is open", async () => {
    const send = composer();
    type("/cft");
    fireEvent.keyDown(field(), { key: "ArrowDown" });

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(send).not.toHaveBeenCalled();
    expect(field().value).toBe("/cft-how-to ");
    expect(field().selectionStart).toBe("/cft-how-to ".length);
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("should pick the active skill when Tab is pressed", () => {
    composer();
    type("/pcs");

    fireEvent.keyDown(field(), { key: "Tab" });

    expect(field().value).toBe("/pcs:start-env ");
  });

  it("should replace only the leading token and keep the rest when a skill is picked", () => {
    composer();
    type("/cf what is CDAM?");
    field().setSelectionRange(3, 3);
    fireEvent.select(field());

    fireEvent.keyDown(field(), { key: "Enter" });

    expect(field().value).toBe("/cft-explain what is CDAM?");
    expect(field().selectionStart).toBe("/cft-explain ".length);
  });

  it("should pick the skill that is clicked", () => {
    composer();
    type("/");

    fireEvent.click(screen.getByRole("option", { name: /pcs:start-env/ }));

    expect(field().value).toBe("/pcs:start-env ");
    expect(document.activeElement).toBe(field());
  });

  it("should close the list on Escape and keep it closed until the message changes", () => {
    composer();
    type("/cft");

    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(field().hasAttribute("aria-activedescendant")).toBe(false);

    type("/cft-");
    expect(field().getAttribute("aria-expanded")).toBe("true");
  });

  it("should send on Enter when the list is closed", async () => {
    const send = composer();
    type("/cft-explain what is CDAM?");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "/cft-explain what is CDAM?" });
  });

  it("should be a plain text box with no list when the agent reported no skills", () => {
    composer([]);

    fireEvent.change(screen.getByRole("textbox", { name: "Message this agent" }), { target: { value: "/" } });

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryAllByRole("option")).toEqual([]);
  });
});

/** Unmounting flushes whatever the throttle still owes, so none of these has to wait on its timer. */
describe("DirectComposer draft", () => {
  it("should restore the unsent message when the composer mounts again for the same agent", () => {
    composer();
    type("half a thought about CDAM");

    cleanup();
    composer();

    expect(field().value).toBe("half a thought about CDAM");
    expect(sessionStorage.getItem(draftKey(VIEWER, AGENT))).toBe("half a thought about CDAM");
  });

  it("should start empty when the agent has no draft of its own", () => {
    composer();
    type("meant for pcs");
    cleanup();

    composer(SKILLS, undefined, { agentId: OTHER_AGENT });

    expect(field().value).toBe("");
    expect(sessionStorage.getItem(draftKey(VIEWER, OTHER_AGENT))).toBeNull();
  });

  it("should keep each agent's draft apart when both have one", () => {
    composer();
    type("meant for pcs");
    cleanup();
    composer(SKILLS, undefined, { agentId: OTHER_AGENT });
    type("meant for the other agent");
    cleanup();

    composer();

    expect(field().value).toBe("meant for pcs");
    expect(sessionStorage.getItem(draftKey(VIEWER, OTHER_AGENT))).toBe("meant for the other agent");
  });

  it("should keep the draft under the virtual agent when its session is replaced by a clear", () => {
    composer(SKILLS, undefined, { agentId: AGENT, virtualAgentId: VIRTUAL_AGENT });
    type("half a thought about CDAM");

    // The page remounts the composer with the agent the new session registered, on the page the person never left.
    cleanup();
    composer(SKILLS, undefined, { agentId: OTHER_AGENT, virtualAgentId: VIRTUAL_AGENT });

    expect(field().value).toBe("half a thought about CDAM");
    expect(sessionStorage.getItem(draftKey(VIEWER, VIRTUAL_AGENT))).toBe("half a thought about CDAM");
    expect(sessionStorage.getItem(draftKey(VIEWER, AGENT))).toBeNull();
  });

  it("should show no draft of the person who signed out when someone else signs in on the same tab", () => {
    composer();
    type("not for anyone else to see");
    cleanup();

    composer(SKILLS, undefined, { viewerOid: OTHER_VIEWER });

    expect(field().value).toBe("");
    expect(sessionStorage.getItem(draftKey(VIEWER, AGENT))).toBe("not for anyone else to see");
  });

  it("should forget the draft when the message is sent", async () => {
    composer();
    type("all finished");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(field().value).toBe("");
    expect(sessionStorage.getItem(draftKey(VIEWER, AGENT))).toBeNull();
    cleanup();
    composer();
    expect(field().value).toBe("");
  });

  it("should keep the next message when it was typed while the send was in flight", async () => {
    // The box is not disabled while the send is in flight, so the next message is typed before the send resolves.
    const send: SendAction = vi.fn(async () => {
      type("and the next thought");
      return { ok: true as const, message: SENT };
    });
    composer(SKILLS, send);
    type("all finished");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "all finished" });
    expect(field().value).toBe("and the next thought");
    cleanup();
    composer();
    expect(field().value).toBe("and the next thought");
  });

  it("should keep the draft when the send is refused", async () => {
    const refused: SendAction = vi.fn(async () => ({ ok: false as const, error: "that agent is not accepting messages" }));
    composer(SKILLS, refused);
    type("worth keeping");

    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(screen.getByRole("alert").textContent).toBe("that agent is not accepting messages");
    expect(field().value).toBe("worth keeping");
    cleanup();
    composer();
    expect(field().value).toBe("worth keeping");
  });

  it("should leave no draft behind when the box is emptied by hand", () => {
    composer();
    type("second thoughts");
    type("");

    cleanup();
    composer();

    expect(field().value).toBe("");
    expect(sessionStorage.getItem(draftKey(VIEWER, AGENT))).toBeNull();
  });

  it("should still send when storage refuses to answer", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("the operation is insecure");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("the quota has been exceeded");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("the operation is insecure");
    });
    const send = composer();

    type("still typable");
    await act(async () => {
      fireEvent.keyDown(field(), { key: "Enter" });
    });

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "still typable" });
    expect(field().value).toBe("");
  });
});
