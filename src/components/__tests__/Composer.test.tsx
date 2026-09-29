/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, defaultTopics } from "@/components/feed/Composer";
import type { ApiMessage } from "@/messages/shape";

afterEach(cleanup);

const POSTED: ApiMessage = {
  id: "4",
  kind: "post",
  title: null,
  body: "hello",
  topics: ["a"],
  in_reply_to: null,
  target_agent_id: null,
  created_at: "2026-09-29T09:00:00.000Z",
  author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null }
};

function post() {
  return screen.getByRole("button", { name: "Post" }) as HTMLButtonElement;
}

describe("defaultTopics", () => {
  it("should start with every topic of the view when it has ten or fewer, and the first ten otherwise", () => {
    expect(defaultTopics(["a", "b"])).toEqual(["a", "b"]);
    expect(defaultTopics(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
    expect(defaultTopics(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"])).toEqual(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
  });
});

describe("Composer", () => {
  it("should post to the chosen topics as a reply and report the new post when the action succeeds", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: POSTED }));
    const onPosted = vi.fn();
    render(<Composer topics={["a", "b"]} post={action} replyTo={{ ...POSTED, id: "2" }} onCancelReply={vi.fn()} onPosted={onPosted} />);

    fireEvent.click(screen.getByLabelText("#b"));
    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(post());
    });

    expect(action).toHaveBeenCalledWith({ topics: ["a"], title: "", body: "hello", inReplyTo: "2" });
    expect(onPosted).toHaveBeenCalledWith(POSTED);
  });

  it("should not let a post be sent when no topic is chosen", () => {
    render(<Composer topics={["a"]} post={vi.fn()} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("#a"));
    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });

    expect(post().disabled).toBe(true);
    expect(screen.getByText("pick at least one topic")).toBeTruthy();
  });

  it("should not let a post be sent when more than ten topics are chosen", () => {
    render(
      <Composer topics={["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]} post={vi.fn()} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />
    );

    fireEvent.click(screen.getByLabelText("#k"));
    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });

    expect(post().disabled).toBe(true);
    expect(screen.getByText("a post has at most 10 topics")).toBeTruthy();
  });

  it("should show the server's refusal when the action refuses", async () => {
    const action = vi.fn(async () => ({ ok: false as const, error: "a post needs between 1 and 10 distinct topics" }));
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(post());
    });

    expect(screen.getByRole("alert").textContent).toContain("between 1 and 10");
  });

  it("should say the post was not sent when the call itself fails", async () => {
    const action = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(post());
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  });

  it("should cancel the reply when asked", () => {
    const onCancelReply = vi.fn();
    render(<Composer topics={["a"]} post={vi.fn()} replyTo={POSTED} onCancelReply={onCancelReply} onPosted={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(onCancelReply).toHaveBeenCalled();
  });

  it("should post the typed title and body when Enter is pressed in the message", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: POSTED }));
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Title (optional)"), { target: { value: "Heads up" } });
    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Enter" });
    });

    expect(action).toHaveBeenCalledWith({ topics: ["a"], title: "Heads up", body: "hello", inReplyTo: null });
    expect((screen.getByPlaceholderText("Title (optional)") as HTMLInputElement).value).toBe("");
  });

  it("should not post when Shift+Enter is pressed or a composition is in progress", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: POSTED }));
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Enter", shiftKey: true });
      fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Enter", isComposing: true });
    });

    expect(action).not.toHaveBeenCalled();
  });

  it("should not post when Enter is pressed and the message is only whitespace", async () => {
    const action = vi.fn(async () => ({ ok: true as const, message: POSTED }));
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "   " } });
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Enter" });
    });

    expect(action).not.toHaveBeenCalled();
  });
});
