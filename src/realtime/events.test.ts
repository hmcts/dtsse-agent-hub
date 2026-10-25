import { describe, expect, it } from "vitest";
import { NOTIFIED_EVENTS } from "./__fixtures__/events.ts";
import { decodeEvent, encodeEvent } from "./events.ts";

describe("encodeEvent and decodeEvent", () => {
  // Driven from the samples record rather than a list written here, because `decodeEvent` answers `undefined` for a
  // type it has no arm for: a new member of the union would be published, cross pods and be dropped by every pod but
  // the publisher, which with more than one replica looks like the UI updating about half the time.
  it.each(NOTIFIED_EVENTS)("should carry a $type event across unchanged", (event) => {
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
    ["skills without an agent", JSON.stringify({ type: "agent_skills", owner_oid: "o" })],
    ["skills without an owner", JSON.stringify({ type: "agent_skills", agent_id: "a" })],
    ["a delivery back to queued", JSON.stringify({ type: "delivery", message_id: "1", agent_id: "a", state: "queued" })],
    ["a delivery without an agent", JSON.stringify({ type: "delivery", message_id: "1", state: "delivered" })],
    ["a grant without a grantee", JSON.stringify({ type: "grant", owner_oid: "o" })],
    ["a transcript without its last id", JSON.stringify({ type: "transcript", agent_id: "a", owner_oid: "o" })],
    ["a transcript without an owner", JSON.stringify({ type: "transcript", agent_id: "a", last_id: "1" })],
    ["a credential without a kind", JSON.stringify({ type: "credential", owner_oid: "o" })],
    ["a credential without an owner", JSON.stringify({ type: "credential", kind: "github" })],
    ["a virtual agent without an id", JSON.stringify({ type: "virtual_agent", owner_oid: "o" })],
    ["a virtual agent without an owner", JSON.stringify({ type: "virtual_agent", virtual_agent_id: "va" })],
    ["a conversation without an id", JSON.stringify({ type: "assistant_conversation", virtual_agent_id: "va", owner_oid: "o" })],
    ["a conversation without its assistant", JSON.stringify({ type: "assistant_conversation", conversation_id: "c", owner_oid: "o" })],
    ["a conversation without an owner", JSON.stringify({ type: "assistant_conversation", conversation_id: "c", virtual_agent_id: "va" })]
  ])("should ignore %s", (_label, payload) => {
    expect(decodeEvent(payload)).toBeUndefined();
  });
});
