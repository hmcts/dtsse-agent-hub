import { describe, expect, it } from "vitest";
import type { ApiMessage } from "./shape.ts";
import { threadFeed } from "./threading.ts";

function message(id: string, inReplyTo: string | null = null): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body: id,
    topics: ["a"],
    in_reply_to: inReplyTo,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null }
  };
}

const shape = (messages: ApiMessage[]) => threadFeed(messages).map((thread) => [thread.root.id, thread.replies.map((reply) => reply.id)]);

describe("threadFeed", () => {
  it("should collapse replies under their parent when the parent is on the page", () => {
    expect(shape([message("1"), message("2"), message("3", "1"), message("4", "1")])).toEqual([
      ["1", ["3", "4"]],
      ["2", []]
    ]);
  });

  it("should put a reply to a reply under the same root when both are on the page", () => {
    expect(shape([message("1"), message("2", "1"), message("3", "2")])).toEqual([["1", ["2", "3"]]]);
  });

  it("should leave a reply on its own when its parent is not on the page", () => {
    expect(shape([message("5", "1"), message("6")])).toEqual([
      ["5", []],
      ["6", []]
    ]);
  });

  it("should keep a root's replies when a reply arrives before its root in the list", () => {
    expect(shape([message("3", "1"), message("1")])).toEqual([["1", ["3"]]]);
  });

  it("should not loop, and show each message once, when replies name each other", () => {
    const threads = threadFeed([message("1", "2"), message("2", "1")]);

    expect(threads.flatMap((thread) => [thread.root.id, ...thread.replies.map((reply) => reply.id)]).sort((a, b) => a.localeCompare(b))).toEqual(["1", "2"]);
  });
});
