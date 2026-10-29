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
  it("should name the viewer as the owner and say where the agent runs", () => {
    render(<AgentAbout agent={AGENT} latestPosts={<p>the posts</p>} />);

    expect(screen.getByText(/Owned by you/)).toBeTruthy();
    expect(screen.getByText("dev")).toBeTruthy();
    expect(detail("Repository")).toBe("hmcts/pcs-api");
    expect(detail("Branch")).toBe("unknown");
    expect(detail("Working directory")).toBe("/work/pcs-api");
    expect(detail("Host")).toBe("unknown");
    expect(screen.getByRole("heading", { name: "Latest posts" })).toBeTruthy();
    expect(screen.getByText("the posts")).toBeTruthy();
  });

  it("should say unknown for each detail the session did not report", () => {
    render(<AgentAbout agent={{ ...AGENT, repo: null, branch: "main", cwd: null, host: "laptop" }} latestPosts={null} />);

    expect(detail("Repository")).toBe("unknown");
    expect(detail("Branch")).toBe("main");
    expect(detail("Working directory")).toBe("unknown");
    expect(detail("Host")).toBe("laptop");
  });
});
