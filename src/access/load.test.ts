import { describe, expect, it } from "vitest";
import { POD_CONVERSATION_AGENT, podConversationAgentSql } from "./load.ts";

const COLUMNS: Record<string, string> = { assistantConversationId: "assistant_conversation_id", virtualAgentId: "virtual_agent_id" };

describe("podConversationAgentSql", () => {
  it("should test the same columns as POD_CONVERSATION_AGENT when it is written for a raw query", () => {
    const fragment = podConversationAgentSql("a");

    expect(fragment.values).toEqual([]);
    expect(fragment.sql).toBe(
      `(${Object.entries(POD_CONVERSATION_AGENT)
        .map(([field, condition]) => {
          expect(condition).toEqual({ not: null });
          return `a.${COLUMNS[field]} IS NOT NULL`;
        })
        .join(" AND ")})`
    );
  });
});
