import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentCard } from "@/agents/views";
import { DevBadge } from "@/components/DevBadge";
import { EmptyState } from "@/components/EmptyState";
import { ChannelHeader } from "@/components/feed/ChannelHeader";
import { ThreadCard } from "@/components/feed/PostCard";
import { PaneBody, PaneHeader } from "@/components/Pane";
import { Section } from "@/components/Section";
import { Sidebar } from "@/components/Sidebar";
import { SignInBanner } from "@/components/SignInBanner";
import { SkeletonFeed, SkeletonList, SkeletonRows } from "@/components/Skeleton";
import { StatusDot } from "@/components/StatusDot";
import type { ApiMessage } from "@/messages/shape";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }), usePathname: () => "/topics/pcs-api" }));

const VIEWER = { oid: "me", tid: "t", name: "Real Person" };

function post(id: string, overrides: Partial<ApiMessage> = {}): ApiMessage {
  return {
    id,
    kind: "post",
    title: null,
    body: "<script>alert(1)</script>",
    topics: ["pcs-api"],
    in_reply_to: null,
    target_agent_id: null,
    created_at: "2026-09-29T09:00:00.000Z",
    author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
    ...overrides
  };
}

function agent(id: string, ownerOid: string, overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    id,
    name: `agent-${id}`,
    status: "idle",
    repo: null,
    branch: null,
    lastHeartbeatAt: "2026-09-29T09:00:00.000Z",
    owner: { oid: ownerOid, name: "Bob Owner", email: null, tid: "dev" },
    ...overrides
  };
}

describe("SignInBanner", () => {
  it("should say sign-in is disabled and name the dev identity when there is a viewer", () => {
    const html = renderToStaticMarkup(<SignInBanner viewer={{ oid: "dev-anonymous", tid: "dev", name: "Anonymous (sign-in disabled)" }} />);

    expect(html).toContain("Sign-in is disabled on this deployment");
    expect(html).toContain("<strong>Anonymous (sign-in disabled)</strong>");
  });

  it("should name nobody when there is no viewer", () => {
    expect(renderToStaticMarkup(<SignInBanner viewer={undefined} />)).toContain("<strong>nobody</strong>");
  });
});

describe("Sidebar", () => {
  it("should list own and shared agents with status, channels and topics when there are some", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        data={{
          mine: [agent("1", "me", { status: "busy" })],
          shared: [agent("2", "bob")],
          channels: {
            mine: [{ id: "c1", name: "Mine", topics: ["a"], match: "any", shared: false, owner: { oid: "me", name: "Me" } }],
            shared: [{ id: "c2", name: "Theirs", topics: ["b"], match: "all", shared: true, owner: { oid: "bob", name: "Bob" } }]
          },
          topics: [{ slug: "pcs-api", message_count: 4, last_message_at: null }]
        }}
        viewer={VIEWER}
        signInDisabled={false}
      />
    );

    expect(html).toContain('href="/agents/1"');
    expect(html).toContain('data-status="busy"');
    expect(html).toContain("Bob Owner");
    expect(html).toContain('href="/channels/c2"');
    expect(html).toContain('href="/topics/pcs-api"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("2 connected");
  });

  it("should list channels, then topics, then agents, and offer sign-out when sign-in is on", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        data={{
          mine: [agent("1", "me")],
          shared: [],
          channels: { mine: [{ id: "c1", name: "Mine", topics: ["a"], match: "any", shared: false, owner: { oid: "me", name: "Me" } }], shared: [] },
          topics: [{ slug: "pcs-api", message_count: 4, last_message_at: null }]
        }}
        viewer={VIEWER}
        signInDisabled={false}
      />
    );

    expect(html.indexOf("/channels/c1")).toBeLessThan(html.indexOf("/topics/pcs-api"));
    expect(html.indexOf("/topics/pcs-api")).toBeLessThan(html.indexOf("/agents/1"));
    expect(html).toContain("Real Person");
    expect(html).toContain("Sign out");
  });

  it("should list connected agents above offline ones", () => {
    const html = renderToStaticMarkup(
      <Sidebar
        data={{
          mine: [agent("1", "me", { status: "offline" }), agent("2", "me", { status: "idle" })],
          shared: [],
          channels: { mine: [], shared: [] },
          topics: []
        }}
        viewer={VIEWER}
        signInDisabled
      />
    );

    expect(html.indexOf("/agents/2")).toBeLessThan(html.indexOf("/agents/1"));
    expect(html).not.toContain("Sign out");
  });

  it("should say what is missing when the viewer has nothing", () => {
    const html = renderToStaticMarkup(
      <Sidebar data={{ mine: [], shared: [], channels: { mine: [], shared: [] }, topics: [] }} viewer={VIEWER} signInDisabled />
    );

    expect(html).toContain("/enable-comms");
    expect(html).toContain("Nobody has granted you access.");
    expect(html).toContain("No saved channels.");
    expect(html).toContain("No posts this week.");
  });
});

describe("ThreadCard", () => {
  it("should escape a post's body and name the person who posted it from the UI", () => {
    const html = renderToStaticMarkup(<ThreadCard thread={{ root: post("1"), replies: [] }} />);

    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Alice");
    expect(html).toContain('<time dateTime="2026-09-29T09:00:00.000Z" title="Tuesday, 29 September 2026 at 10:00 BST (UK time)"');
  });

  it("should name the agent and its owner, the title, and a missing parent when it is an agent's reply", () => {
    const html = renderToStaticMarkup(
      <ThreadCard
        thread={{
          root: post("5", {
            title: "A title",
            in_reply_to: "2",
            author: { type: "agent", agent_id: "a", agent_name: "pcs", owner_name: "Bob", owner_email: null }
          }),
          replies: [post("6"), post("7")]
        }}
      />
    );

    expect(html).toContain("@pcs");
    expect(html).toContain("(Bob)");
    expect(html).toContain("A title");
    expect(html).toContain("In reply to #2");
    expect(html).toContain("2 replies");
  });
});

describe("ChannelHeader", () => {
  it("should offer the other mode, a shareable link and saving when the view has several topics", () => {
    const html = renderToStaticMarkup(<ChannelHeader kind="Channel view" title="x" topics={["a", "b"]} match="any" saveable />);

    expect(html).toContain('href="/c?topics=a,b&amp;mode=all"');
    expect(html).toContain('href="/channels/new?topics=a,b&amp;mode=any"');
  });

  it("should offer neither the mode switch nor saving when there is one topic and it cannot be saved", () => {
    const html = renderToStaticMarkup(<ChannelHeader kind="Channel" title="x" topics={["a"]} match="all" saveable={false} />);

    expect(html).not.toContain("Match any");
    expect(html).not.toContain("Save as channel");
    expect(html).toContain("all of these");
  });
});

describe("small components", () => {
  it("should render a status as a dot with its word for screen readers", () => {
    expect(renderToStaticMarkup(<StatusDot status="offline" />)).toContain('<span class="sr-only">offline</span>');
  });

  it("should mark a dev owner and nobody else", () => {
    expect(renderToStaticMarkup(<DevBadge tid="dev" />)).toContain("dev");
    expect(renderToStaticMarkup(<DevBadge tid="real-tenant" />)).toBe("");
  });

  it("should render a section with its detail and action, and without a body when empty", () => {
    const html = renderToStaticMarkup(<Section heading="H" detail="d" action={<span>act</span>} />);

    expect(html).toContain("act");
    expect(html).not.toContain('class="p-4"');
  });

  it("should render an empty state with and without detail, and a skeleton that says loading", () => {
    expect(renderToStaticMarkup(<EmptyState message="none" detail="why" />)).toContain("why");
    expect(renderToStaticMarkup(<EmptyState message="none" />)).not.toContain("mt-1");
    expect(renderToStaticMarkup(<SkeletonList rows={2} />)).toContain('role="status"');
  });

  it("should say loading once and hide its bars when a page streams its feed under a rendered header", () => {
    const feed = renderToStaticMarkup(<SkeletonFeed rows={3} />);

    expect(feed.match(/role="status"/g)).toHaveLength(1);
    expect(feed.match(/animate-pulse/g)).toHaveLength(9);
    expect(feed).not.toContain("min-h-[49px]");
  });

  it("should render rows hidden from screen readers and without a status when part of a pane is loading", () => {
    const rows = renderToStaticMarkup(<SkeletonRows rows={2} />);

    expect(rows).toMatch(/^<div aria-hidden="true"/);
    expect(rows).not.toContain("role=");
  });

  it("should render a pane header with its kind, subtitle and actions, and a body around its content", () => {
    const header = renderToStaticMarkup(<PaneHeader title="Title" kind="topic" subtitle="sub" actions={<a href="/x">act</a>} />);
    const bare = renderToStaticMarkup(<PaneHeader title="Title" />);

    expect(header).toContain("topic");
    expect(header).toContain("sub");
    expect(header).toContain('<a href="/x">act</a>');
    expect(bare).not.toContain("ml-auto");
    expect(renderToStaticMarkup(<PaneBody>content</PaneBody>)).toContain('overflow-y-auto px-5 py-5">content</div>');
  });
});
