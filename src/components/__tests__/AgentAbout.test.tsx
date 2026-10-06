/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DEV_TENANT } from "@/agent-auth/dev";
import type { AgentDetail } from "@/agents/views";
import { AgentAbout } from "@/components/agents/AgentAbout";

afterEach(() => {
  cleanup();
});

const AGENT: AgentDetail = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "pcs",
  status: "idle",
  repo: "hmcts/pcs-api",
  branch: null,
  lastHeartbeatAt: "2026-09-29T09:00:00.000Z",
  owner: { oid: "owner-oid", tid: DEV_TENANT, name: "Bob", email: null },
  virtualAgentId: null,
  cwd: "/work/pcs-api",
  host: null,
  createdAt: "2026-09-28T09:00:00.000Z"
};

function detail(term: string): string {
  return screen.getByText(term).nextElementSibling?.textContent ?? "";
}

describe("AgentAbout", () => {
  it("should name the owner, the viewer's access and where the agent runs when shown to a grantee", () => {
    render(<AgentAbout agent={AGENT} access="read" ownedByViewer={false} latestPosts={<p>the posts</p>} />);

    expect(screen.getByText(/Owned by Bob/)).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(screen.getByText("You have read access")).toBeTruthy();
    expect(detail("Repository")).toBe("hmcts/pcs-api");
    expect(detail("Branch")).toBe("unknown");
    expect(detail("Working directory")).toBe("/work/pcs-api");
    expect(detail("Host")).toBe("unknown");
    expect(screen.getByRole("heading", { name: "Latest posts" })).toBeTruthy();
    expect(screen.getByText("the posts")).toBeTruthy();
  });

  it("should say the viewer owns it when they do", () => {
    render(<AgentAbout agent={{ ...AGENT, repo: null, branch: "main", cwd: null, host: "laptop" }} access="owner" ownedByViewer latestPosts={null} />);

    expect(screen.getByText(/Owned by you/)).toBeTruthy();
    expect(screen.getByText("You own this agent")).toBeTruthy();
    expect(detail("Repository")).toBe("unknown");
    expect(detail("Branch")).toBe("main");
    expect(detail("Working directory")).toBe("unknown");
    expect(detail("Host")).toBe("laptop");
  });
});
