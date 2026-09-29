/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectThread, mayMessage } from "@/components/agents/DirectThread";
import type { ThreadMessage } from "@/messages/direct-thread";

const AGENT = "11111111-1111-1111-1111-111111111111";

function message(id: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id,
    kind: "direct",
    title: null,
    body: `message ${id}`,
    topics: [],
    in_reply_to: null,
    target_agent_id: AGENT,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    delivery: "queued",
    ...overrides
  };
}

afterEach(cleanup);

describe("mayMessage", () => {
  it.each([
    ["owner", true],
    ["write", true],
    ["read", false]
  ] as const)("should decide %s may message: %s", (access, expected) => {
    expect(mayMessage(access)).toBe(expected);
  });
});

describe("DirectThread", () => {
  it.each(["owner", "write"] as const)("should show the composer when the viewer has %s access", (access) => {
    render(<DirectThread agentId={AGENT} access={access} initial={[]} send={vi.fn()} />);

    expect(screen.getByRole("form", { name: "Message this agent" })).toBeTruthy();
    expect(screen.queryByTestId("read-only-thread")).toBeNull();
  });

  it("should hide the composer and say why when the viewer has read access only", () => {
    render(<DirectThread agentId={AGENT} access="read" initial={[message("1")]} send={vi.fn()} />);

    expect(screen.queryByRole("form", { name: "Message this agent" })).toBeNull();
    expect(screen.getByTestId("read-only-thread").textContent).toContain("read access");
    expect(screen.getByText("message 1")).toBeTruthy();
  });

  it("should show each message's delivery state and nothing for a reply with no target when rendering the thread", () => {
    render(
      <DirectThread
        agentId={AGENT}
        access="read"
        initial={[
          message("1", { delivery: "delivered" }),
          message("2", {
            target_agent_id: null,
            delivery: null,
            author: { type: "agent", agent_id: AGENT, agent_name: "pcs", owner_name: "Bob", owner_email: null }
          })
        ]}
        send={vi.fn()}
      />
    );

    expect(screen.getByText("delivered")).toBeTruthy();
    expect(screen.getByText("replied")).toBeTruthy();
    expect(screen.getAllByText(/queued|delivered|expired/)).toHaveLength(1);
  });

  it("should add the sent message to the thread and clear the box when sending succeeds", async () => {
    const send = vi.fn(async () => ({ ok: true as const, message: message("9", { body: "hello agent" }) }));
    render(<DirectThread agentId={AGENT} access="owner" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello agent" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(send).toHaveBeenCalledWith({ agentId: AGENT, body: "hello agent" });
    expect(screen.getByText("hello agent")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("should show the refusal when the server refuses the message", async () => {
    const send = vi.fn(async () => ({ ok: false as const, error: "you have read access to this agent, not write access" }));
    render(<DirectThread agentId={AGENT} access="write" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("not write access");
  });

  it("should say the message could not be sent when the call itself fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<DirectThread agentId={AGENT} access="write" initial={[]} send={send} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: "Message this agent" }));
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  });
});
