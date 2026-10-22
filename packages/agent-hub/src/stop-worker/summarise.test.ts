import { describe, expect, it } from "vitest";
import type { Message } from "../api.ts";
import { buildPrompt, formatFeed, parseHaikuResult, validateHaikuOutput } from "./summarise.ts";

const message = (over: Partial<Message> = {}): Message => ({
  id: "1",
  kind: "post",
  title: null,
  body: "",
  topics: [],
  in_reply_to: null,
  target_agent_id: null,
  created_at: "2026-10-22T09:00:00.000Z",
  author: { type: "agent", agent_id: "agent-1", agent_name: null, owner_name: "Olive Owner", owner_email: null },
  ...over
});

describe("validateHaikuOutput", () => {
  it("should accept the exact schema when both fields have the right shape", () => {
    // Act & Assert
    expect(validateHaikuOutput({ publish: null, notify: null }).ok).toBe(true);
    expect(validateHaikuOutput({ publish: { topics: ["pcs-api"], title: "T", body: "B" }, notify: "see #12" }).ok).toBe(true);
  });

  it("should accept ten topics when the post is at the hub's limit", () => {
    // Arrange
    const topics = Array.from({ length: 10 }, (_, i) => `t${i}`);

    // Act & Assert
    expect(validateHaikuOutput({ publish: { topics, title: "T", body: "B" }, notify: null }).ok).toBe(true);
  });

  it("should reject anything else", () => {
    // Arrange
    const bad: unknown[] = [
      null,
      [],
      "text",
      { publish: null },
      { publish: null, notify: null, extra: 1 },
      { publish: { topics: [], title: "T", body: "B" }, notify: null },
      { publish: { topics: Array.from({ length: 11 }, (_, i) => `t${i}`), title: "T", body: "B" }, notify: null },
      { publish: { topics: ["Bad Slug"], title: "T", body: "B" }, notify: null },
      { publish: { topics: ["-lead"], title: "T", body: "B" }, notify: null },
      { publish: { topics: ["a", "a"], title: "T", body: "B" }, notify: null },
      { publish: { topics: ["a"], title: " ", body: "B" }, notify: null },
      { publish: { topics: ["a"], title: "T", body: "B", in_reply_to: "1" }, notify: null },
      { publish: { topics: ["a"], title: "T".repeat(201), body: "B" }, notify: null },
      { publish: null, notify: "" },
      { publish: null, notify: 42 }
    ];

    // Act & Assert
    for (const value of bad) {
      expect(validateHaikuOutput(value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  it("should reject a body over 8000 characters and a publish that is not an object", () => {
    // Act & Assert
    expect(validateHaikuOutput({ publish: { topics: ["a"], title: "T", body: "B".repeat(8001) }, notify: null })).toEqual({
      ok: false,
      error: "publish.body invalid"
    });
    expect(validateHaikuOutput({ publish: 5, notify: null })).toEqual({ ok: false, error: "publish is not an object or null" });
  });
});

describe("parseHaikuResult", () => {
  it("should unwrap claude -p json output whether or not the model fenced it", () => {
    // Arrange
    const inner = { publish: null, notify: "x" };

    // Act & Assert
    expect(parseHaikuResult(JSON.stringify({ type: "result", result: JSON.stringify(inner) }))).toEqual(inner);
    expect(parseHaikuResult(JSON.stringify({ type: "result", result: `\`\`\`json\n${JSON.stringify(inner)}\n\`\`\`` }))).toEqual(inner);
    expect(() => parseHaikuResult(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toThrow();
    expect(() => parseHaikuResult(JSON.stringify({ type: "result", result: "Sure! here you go" }))).toThrow();
  });
});

describe("formatFeed", () => {
  it("should name the author and fall back to the owner when a message has no agent", () => {
    // Act
    const text = formatFeed([
      message({ id: "50", topics: ["pcs-api"], title: "Schema change", body: "cases table renamed", author: { ...message().author, agent_name: "bob" } }),
      message({ id: "51", title: null, body: "from a person" }),
      message({ id: "52", body: "no one", author: { ...message().author, owner_name: "" } })
    ]);

    // Assert
    expect(text).toBe(
      "#50 [pcs-api] @bob: Schema change\ncases table renamed\n\n#51 [] Olive Owner: (untitled)\nfrom a person\n\n#52 [] unknown: (untitled)\nno one"
    );
  });

  it("should stop once the items no longer fit the prompt", () => {
    // Arrange: each body is clipped to 1500 characters, so 20000 characters is reached part way through.
    const many = Array.from({ length: 30 }, (_, i) => message({ id: String(i), body: "x".repeat(4000) }));

    // Act
    const text = formatFeed(many);

    // Assert
    expect(text.length).toBeLessThanOrEqual(20000);
    expect(text).toContain("…");
    expect(text.split("\n\n").length).toBeLessThan(30);
  });
});

describe("buildPrompt", () => {
  it("should state what is allowed and list the topics when only notifying is due", () => {
    // Act
    const p = buildPrompt({
      agentName: "me",
      subscriptions: ["pcs-api"],
      activeTopics: ["ccd"],
      sliceText: "S",
      feedText: "F",
      offerPublish: false,
      offerNotify: true
    });

    // Assert
    expect(p).toMatch(/PUBLISH is NOT allowed/);
    expect(p).toMatch(/NOTIFY is allowed/);
    expect(p).toMatch(/Subscribed topics: pcs-api/);
    expect(p).toMatch(/Most active topics: ccd/);
    expect(p).toMatch(/scripts\/agent-hub read <id>/);
  });

  it("should explain the topic categories and vocabulary and pass the candidates", () => {
    // Act
    const p = buildPrompt({
      agentName: "me",
      subscriptions: [],
      activeTopics: [],
      candidates: {
        repos: ["pcs-api", "ccd-data-store-api"],
        products: ["pcs", "ccd"],
        tickets: ["hdpi-8713", "pcs-api-pr-52"],
        workedIn: { repos: ["pcs-api"], products: ["pcs"] }
      },
      sliceText: "S",
      feedText: "",
      offerPublish: true,
      offerNotify: false
    });

    // Assert
    expect(p).toMatch(/1 to 10 lowercase slugs/);
    expect(p).toMatch(/At most 10 in total/);
    expect(p).toMatch(/repos worked on: bare repo names without "hmcts\//);
    expect(p).toMatch(/"libs" or "platops"/);
    expect(p).toMatch(/<repo>-issue-<n> and <repo>-pr-<n>/);
    expect(p).toMatch(
      /only from: infrastructure, feature, bugfix, frontend, backend, database, architecture, documentation, testing, ci, security, performance, dependencies, refactor\./
    );
    expect(p).toMatch(/keep repos and tickets first, then products, then the one or two most relevant work types/);
    expect(p).toMatch(/working directory therefore says nothing about which repo/);
    expect(p).toMatch(/Tag cft-workspace only when the workspace's own files changed/);
    expect(p).toMatch(/Prefer the ones worked in/);
    expect(p).toMatch(/use its spelling/);
    expect(p).toMatch(/Candidate repos worked in: pcs-api\n/);
    expect(p).toMatch(/Candidate repos only read or mentioned: ccd-data-store-api\n/);
    expect(p).toMatch(/Candidate products worked in: pcs\n/);
    expect(p).toMatch(/Candidate products only read or mentioned: ccd\n/);
    expect(p).toMatch(/Candidate tickets: hdpi-8713, pcs-api-pr-52\n/);
    expect(buildPrompt({ agentName: "me", subscriptions: [], activeTopics: [], sliceText: "", feedText: "" })).toMatch(
      /Candidate repos worked in: \(none\)\nCandidate repos only read or mentioned: \(none\)/
    );
  });

  it("should say nothing is new when neither the transcript nor the feed has anything", () => {
    // Act
    const p = buildPrompt({ agentName: "me", subscriptions: [], activeTopics: [], sliceText: "", feedText: "" });

    // Assert
    expect(p).toContain("=== Recent transcript of this session ===\n(nothing new)\n");
    expect(p).toContain("=== New feed items on subscribed topics ===\n(none)\n");
  });
});
