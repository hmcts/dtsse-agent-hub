import { describe, expect, it } from "vitest";
import { mergeMessages, toPage } from "./pagination.ts";
import type { ApiMessage } from "./shape.ts";

function message(id: string, body = `message ${id}`): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body,
    topics: ["a"],
    in_reply_to: null,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null }
  };
}

const ids = (messages: readonly { id: string }[]) => messages.map((entry) => entry.id);

describe("toPage", () => {
  it("should drop the extra oldest row and point older pages at the oldest shown when there are more rows than the limit", () => {
    const page = toPage([message("1"), message("2"), message("3"), message("4")], 3);

    expect(ids(page.messages)).toEqual(["2", "3", "4"]);
    expect(page.olderBefore).toBe("2");
  });

  it("should report no older page when the rows fit the limit", () => {
    expect(toPage([message("1"), message("2")], 3)).toEqual({ messages: [message("1"), message("2")], olderBefore: null });
  });

  it("should report no older page when there are no rows", () => {
    expect(toPage([], 3)).toEqual({ messages: [], olderBefore: null });
  });

  it("should use a page of thirty when no limit is given", () => {
    const rows = Array.from({ length: 31 }, (_, index) => message(String(index + 1)));

    expect(toPage(rows).messages).toHaveLength(30);
  });
});

describe("mergeMessages", () => {
  it("should keep each message once, oldest first by numeric id, when pages and live events overlap", () => {
    expect(ids(mergeMessages([message("9"), message("10")], [message("2"), message("10"), message("11")]))).toEqual(["2", "9", "10", "11"]);
  });

  it("should keep the incoming copy of a message when both lists carry it", () => {
    expect(mergeMessages([message("1", "old")], [message("1", "new")])[0]?.body).toBe("new");
  });
});
