/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentView } from "@/agents/views";
import { AgentLayout } from "@/components/agents/AgentLayout";
import { type VirtualAgentActions, VirtualAgentPanel, VirtualAgentPending } from "@/components/virtual-agents/VirtualAgentPanel";
import type { VirtualAgentCard } from "@/virtual-agents/views";
import type { VirtualAgentPageView } from "@/web/data";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/" }));
vi.mock("@/components/live/HubStream", () => ({ useHubEvent: () => undefined, useEndSession: () => () => undefined }));

afterEach(() => {
  cleanup();
});

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const VIRTUAL_ID = "0f8a6a1e-0000-4000-8000-000000000001";
const SESSION_ID = "11111111-1111-1111-1111-111111111111";

const CARD: VirtualAgentCard = {
  id: VIRTUAL_ID,
  name: "pcs-api",
  desired: "running",
  status: "running",
  statusDetail: null,
  modelRoute: "bedrock",
  size: "small",
  exposedPorts: [],
  localOnlyPorts: [],
  stopReason: null,
  lastActivityAt: null,
  stoppedAt: null,
  diskExpiresAt: null,
  diskDeletedAt: null,
  agentId: SESSION_ID,
  createdAt: "2026-10-05T09:00:00.000Z"
};

const LINKED: AgentView = {
  agent: {
    id: SESSION_ID,
    name: "pcs-api",
    status: "idle",
    repo: null,
    branch: null,
    lastHeartbeatAt: "2026-10-05T11:00:00.000Z",
    owner: { oid: "alice", name: "Alice", email: null, tid: "a-tenant" },
    virtualAgentId: VIRTUAL_ID,
    cwd: null,
    host: null,
    createdAt: "2026-10-05T10:00:00.000Z"
  },
  access: "read",
  grants: [],
  skills: []
};

function page(overrides: Partial<VirtualAgentPageView> = {}): VirtualAgentPageView {
  return {
    summary: { id: VIRTUAL_ID, name: "pcs-api", desired: "running", status: "running", agentId: null, owner: { oid: "alice", name: "Alice", tid: "a-tenant" } },
    manage: {
      detail: { card: CARD, logins: [], needed: ["github", "azure", "bedrock"], optional: ["jenkins"] },
      credentials: { available: true, modelRoute: "bedrock", statuses: [] }
    },
    linked: null,
    ...overrides
  };
}

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

const ACTIONS: VirtualAgentActions = {
  lifecycle: { start: ok(), stop: ok(), remove: ok() },
  rename: ok(),
  resize: ok(),
  paste: ok(),
  reconnect: ok(),
  save: ok()
};

describe("AgentLayout", () => {
  it("should show the header, the conversation and the side panel twice, folded on narrow screens, when the agent is local", () => {
    render(
      <AgentLayout title="laptop" kind="Agent" subtitle="idle" side={<p>about it</p>} sideLabel="About this agent" narrow="disclosure">
        <p>the conversation</p>
      </AgentLayout>
    );

    expect(screen.getByRole("heading", { level: 1, name: "laptop" })).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Conversation" })).getByText("the conversation")).toBeTruthy();
    expect(screen.getByText("About this agent", { selector: "summary" })).toBeTruthy();
    expect(screen.getAllByText("about it")).toHaveLength(2);
    expect(within(screen.getByRole("complementary", { name: "About this agent" })).getByText("about it")).toBeTruthy();
  });

  it("should render the side panel once, below the conversation, when the agent is virtual", () => {
    render(
      <AgentLayout title="pcs-api" kind="Virtual agent" subtitle="Running" side={<p>its panels</p>} sideLabel="About this virtual agent" narrow="below">
        <p>the conversation</p>
      </AgentLayout>
    );

    expect(screen.getByText("Virtual agent")).toBeTruthy();
    expect(screen.queryByText("About this virtual agent", { selector: "summary" })).toBeNull();
    expect(screen.getAllByText("its panels")).toHaveLength(1);
    expect(within(screen.getByRole("complementary", { name: "About this virtual agent" })).getByText("its panels")).toBeTruthy();
  });
});

describe("VirtualAgentPanel", () => {
  it("should give the owner the lifecycle, settings and sign-ins, and no session details, when no session has registered", () => {
    render(<VirtualAgentPanel page={page()} actions={ACTIONS} now={NOW} session={null} />);

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Rename pcs-api" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Sign-ins" })).toBeTruthy();
    expect(screen.queryByText(/runs for Alice/)).toBeNull();
  });

  it("should show the current session's details after the owner's panels when a session has registered", () => {
    render(<VirtualAgentPanel page={page({ linked: { ...LINKED, access: "owner" } })} actions={ACTIONS} now={NOW} session={<p>the session</p>} />);

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.getByText("the session")).toBeTruthy();
  });

  it("should tell a grantee whose it is and offer none of the owner's controls when the viewer does not own it", () => {
    render(<VirtualAgentPanel page={page({ manage: null, linked: LINKED })} actions={ACTIONS} now={NOW} session={<p>the session</p>} />);

    expect(screen.getByText(/A virtual agent the hub runs for Alice/)).toBeTruthy();
    expect(screen.getByText("the session")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("form")).toEqual([]);
    expect(screen.queryByRole("list", { name: "Sign-ins" })).toBeNull();
  });
});

describe("VirtualAgentPending", () => {
  it.each([
    ["running", "Starting…", "The conversation appears once Claude has started."],
    ["stopped", "No conversation yet.", "It appears once the virtual agent is started and Claude is running."],
    ["deleted", "No conversation.", null]
  ] as const)("should say what the conversation is waiting for when the virtual agent is %s", (desired, message, detail) => {
    render(<VirtualAgentPending desired={desired} />);

    expect(screen.getByText(message)).toBeTruthy();
    if (detail !== null) {
      expect(screen.getByText(detail)).toBeTruthy();
    }
  });
});
