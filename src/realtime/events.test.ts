import { describe, expect, it } from "vitest";
import { decodeEvent, encodeEvent, type NotifiedEvent } from "./events.ts";

describe("encodeEvent and decodeEvent", () => {
  it.each<NotifiedEvent>([
    { type: "post", message_id: "12" },
    { type: "direct", message_id: "13", target_agent_id: "agent-b", author_agent_id: "agent-a" },
    { type: "direct", message_id: "14", target_agent_id: null, author_agent_id: "agent-a" },
    { type: "direct", message_id: "15", target_agent_id: "agent-b", author_agent_id: null },
    { type: "agent_status", agent_id: "agent-a", owner_oid: "oid-a", status: "offline" },
    { type: "delivery", message_id: "16", agent_id: "agent-b", state: "delivered" }
  ])("should carry a $type event across unchanged", (event) => {
    expect(decodeEvent(encodeEvent(event))).toEqual(event);
  });

  it("should drop fields it does not know rather than pass them to subscribers", () => {
    expect(decodeEvent(JSON.stringify({ type: "post", message_id: "1", body: "secret" }))).toEqual({ type: "post", message_id: "1" });
  });

  it.each([
    ["no payload", undefined],
    ["something that is not JSON", "{"],
    ["JSON that is not an object", "42"],
    ["null", "null"],
    ["an unknown type", JSON.stringify({ type: "reaction", message_id: "1" })],
    ["a resync, which never crosses pods", JSON.stringify({ type: "resync" })],
    ["a post without an id", JSON.stringify({ type: "post" })],
    ["a numeric id", JSON.stringify({ type: "post", message_id: 1 })],
    ["a direct with a missing target field", JSON.stringify({ type: "direct", message_id: "1", author_agent_id: null })],
    ["an unknown status", JSON.stringify({ type: "agent_status", agent_id: "a", owner_oid: "o", status: "asleep" })],
    ["a status without an owner", JSON.stringify({ type: "agent_status", agent_id: "a", status: "idle" })],
    ["a delivery back to queued", JSON.stringify({ type: "delivery", message_id: "1", agent_id: "a", state: "queued" })],
    ["a delivery without an agent", JSON.stringify({ type: "delivery", message_id: "1", state: "delivered" })]
  ])("should ignore %s", (_label, payload) => {
    expect(decodeEvent(payload)).toBeUndefined();
  });
});
