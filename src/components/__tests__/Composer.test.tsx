/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, defaultTopics } from "@/components/feed/Composer";
import type { ApiMessage } from "@/messages/shape";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sessionAnswers(status: number) {
  const fetch = vi.fn(async () => new Response(null, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

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

  it("should say the post was not sent when the call fails and the session is still good", async () => {
    sessionAnswers(204);
    const action = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(post());
    });

    expect(screen.getByRole("alert").textContent).toContain("could not be sent");
    expect(screen.queryByText(/session has ended/)).toBeNull();
  });

  it("should offer to sign in again, back to this page, when the call fails because the session has ended", async () => {
    sessionAnswers(401);
    window.history.pushState({}, "", "/c?topics=a&mode=any");
    const action = vi.fn(async () => {
      throw new Error("An unexpected response was received from the server.");
    });
    render(<Composer topics={["a"]} post={action} replyTo={null} onCancelReply={vi.fn()} onPosted={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("Write a post"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(post());
    });

    expect(screen.getByRole("status").textContent).toContain("Your session has ended");
    const href = new URL(screen.getByRole("link", { name: "Sign in again" }).getAttribute("href") ?? "", "https://agent-hub.example");
    expect(href.pathname).toBe("/auth/login");
    expect(href.searchParams.get("redirect")).toBe("/c?topics=a&mode=any");
    window.history.pushState({}, "", "/");
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

describe("Composer reply mode", () => {
  function replyingTo(onCancelReply: () => void) {
    render(
      <>
        <button type="button" data-reply-to="2">
          Reply to post 2
        </button>
        <Composer topics={["a"]} post={vi.fn()} replyTo={{ ...POSTED, id: "2" }} onCancelReply={onCancelReply} onPosted={vi.fn()} />
      </>
    );
  }

  it("should cancel the reply and hand focus back to its reply button when Escape is pressed", () => {
    const onCancelReply = vi.fn();
    replyingTo(onCancelReply);
    const box = screen.getByPlaceholderText("Write a post");
    box.focus();

    fireEvent.keyDown(box, { key: "Escape" });

    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply to post 2" }));
  });

  it("should hand focus back to the reply button when the reply is cancelled with the button", () => {
    const onCancelReply = vi.fn();
    replyingTo(onCancelReply);

    fireEvent.click(screen.getByRole("button", { name: "Cancel reply" }));

    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reply to post 2" }));
  });

  it("should ignore Escape when there is no reply in progress", () => {
    const onCancelReply = vi.fn();
    render(<Composer topics={["a"]} post={vi.fn()} replyTo={null} onCancelReply={onCancelReply} onPosted={vi.fn()} />);

    fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "Escape" });
    fireEvent.keyDown(screen.getByPlaceholderText("Write a post"), { key: "a" });

    expect(onCancelReply).not.toHaveBeenCalled();
  });
});
