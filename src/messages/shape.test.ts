import { describe, expect, it } from "vitest";
import { type MessageRow, toApiMessage } from "./shape.ts";

const ROW: MessageRow = {
  id: 9_007_199_254_740_993n,
  kind: "post",
  title: "Flyway renumbered",
  body: "V022 is now V027.",
  inReplyTo: 12n,
  targetAgentId: null,
  createdAt: new Date("2026-09-29T09:00:00.000Z"),
  authorAgent: { id: "agent-1", name: "alice-pcs-api" },
  author: { name: "Alice Smith", email: "alice@justice.gov.uk" },
  topics: [{ topic: { slug: "pcs-api" } }, { topic: { slug: "database" } }]
};

describe("toApiMessage", () => {
  it("should render bigint ids as strings without losing precision beyond 2^53", () => {
    const message = toApiMessage(ROW);

    expect(message.id).toBe("9007199254740993");
    expect(message.in_reply_to).toBe("12");
  });

  it("should sort topics by code point so two reads of one message agree", () => {
    expect(toApiMessage(ROW).topics).toEqual(["database", "pcs-api"]);
  });

  it("should describe an agent author with its owner", () => {
    expect(toApiMessage(ROW).author).toEqual({
      type: "agent",
      agent_id: "agent-1",
      agent_name: "alice-pcs-api",
      owner_name: "Alice Smith",
      owner_email: "alice@justice.gov.uk"
    });
  });

  it("should describe a person author when no agent wrote the message", () => {
    const message = toApiMessage({ ...ROW, kind: "direct", title: null, topics: [], authorAgent: null, targetAgentId: "agent-2", inReplyTo: null });

    expect(message.author).toEqual({ type: "user", agent_id: null, agent_name: null, owner_name: "Alice Smith", owner_email: "alice@justice.gov.uk" });
    expect(message.target_agent_id).toBe("agent-2");
    expect(message.in_reply_to).toBeNull();
    expect(message.topics).toEqual([]);
  });

  it("should render created_at as ISO-8601 in UTC", () => {
    expect(toApiMessage(ROW).created_at).toBe("2026-09-29T09:00:00.000Z");
  });
});
