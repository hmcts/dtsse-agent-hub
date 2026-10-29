/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readiness } from "@/assistant/onboarding";
import { TEMPLATES } from "@/assistant/starters";
import type { AssistantSummary, ConversationView } from "@/assistant/views";
import { AssistantGate } from "@/components/assistant/AssistantGate";
import { type ChatActions, ChatView } from "@/components/assistant/ChatView";
import type { CredentialKind } from "@/credentials/names";
import type { CredentialStatus } from "@/credentials/store";
import type { ThreadMessage } from "@/messages/direct-thread";
import { neededCredentials, OPTIONAL_CREDENTIALS } from "@/virtual-agents/views";
import type { AssistantHome } from "@/web/data";

const AGENT = "11111111-1111-1111-1111-111111111111";
const CONVERSATION = "22222222-2222-2222-2222-222222222222";
const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ASSISTANT = "0f8a6a1e-0000-4000-8000-000000000001";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/assistant" }));

vi.mock("@/components/live/HubStream", () => ({
  useHubEvent: () => undefined,
  useEndSession: () => () => undefined,
  useWatch: () => undefined
}));

// `AssistantGate` is a server component and reaches its actions by importing them, so the three server-action modules
// are stood in for: without this the `server-only` they pull in refuses to load under a client module graph.
vi.mock("@/app/_actions/credentials", () => ({ saveCredential: vi.fn() }));
vi.mock("@/app/_actions/virtual-agents", () => ({ pasteLoginCode: vi.fn(), reconnectSignIn: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined })
  });
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function ok() {
  return vi.fn(async () => ({ ok: true as const }));
}

function assistant(overrides: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: ASSISTANT,
    name: "assistant",
    desired: "running",
    modelRoute: "gateway",
    status: "awaiting_credentials",
    statusDetail: null,
    statusChangedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    readiness: readiness("awaiting_credentials"),
    needed: neededCredentials("own-licence"),
    optional: OPTIONAL_CREDENTIALS,
    logins: [],
    onboarded: false,
    toChat: ["github", "claude"],
    ...overrides
  };
}

function statuses(...stored: CredentialKind[]): CredentialStatus[] {
  return stored.map((kind) => ({ kind, stored: true, accountLabel: null, updatedAt: new Date().toISOString(), updatedVia: null }));
}

/**
 * What the page hands the gate. `chat` is passed rather than derived, because that is how the page passes it: the
 * gate's whole job is to read the viewer's gate beside the page's own chat, and a test that recomputed one from the
 * other could not put them in disagreement, which is the case this file is about.
 */
function home(chat: AssistantHome["chat"], stored: CredentialStatus[] = [], overrides: Partial<AssistantSummary> = {}): AssistantHome {
  return {
    assistant: assistant(overrides),
    credentials: { modelRoute: "own-licence", claudeTokenUsable: true, available: true, statuses: stored },
    conversations: [],
    plugins: null,
    chat
  };
}

function conversation(local: boolean): ConversationView {
  return {
    id: CONVERSATION,
    title: "Writing a story",
    product: "ccd",
    productLabel: "CCD",
    productHistory: [],
    stopHistory: [],
    local,
    agentId: AGENT,
    agentStatus: "idle",
    skills: [],
    clientFeatures: null,
    sessionState: null,
    sessionDetail: null,
    artefact: { title: null, markdown: "", version: 0, updatedBy: null, updatedAt: null },
    jira: { status: "none" },
    confluence: { status: "none" },
    page: { messages: [], entries: [], olderBefore: null, lastId: null, more: false },
    forked: null,
    questions: []
  };
}

const SENT: ThreadMessage = {
  id: "99",
  kind: "direct",
  title: null,
  body: "sent",
  topics: [],
  tagged_agents: [],
  in_reply_to: null,
  target_agent_id: AGENT,
  created_at: "2026-10-29T09:00:00.000Z",
  author: { type: "user", agent_id: null, agent_name: null, owner_name: "Alice", owner_email: null },
  delivery: "delivered"
};

function actions(): ChatActions {
  return {
    send: vi.fn(async () => ({ ok: true as const, message: SENT })),
    warm: ok(),
    stop: vi.fn(async () => ({ ok: true as const, stopped: true })),
    setProduct: ok(),
    rename: ok(),
    remove: ok(),
    answerQuestion: ok(),
    saveArtefact: vi.fn(async () => ({ ok: true as const, saved: true as const, version: 1 })),
    exportToJira: ok()
  };
}

/**
 * A conversation's page as it renders it: the real chat behind the real gate, so "the composer is there" is the
 * message box a person would type into rather than a stand-in for one.
 */
function chatPage(chat: AssistantHome["chat"], local: boolean, stored: CredentialStatus[] = []) {
  return (
    <AssistantGate home={home(chat, stored)} waiting={undefined} theme="system" local={local}>
      <ChatView
        view={conversation(local)}
        templates={TEMPLATES}
        viewerOid={VIEWER}
        actions={actions()}
        jira={{ connected: false, login: null }}
        defaults={{ jira: null, confluence: null }}
      />
    </AssistantGate>
  );
}

/** The getting-ready screen, which is `fixed inset-0` and takes the whole page while it is up. */
function overlay(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: /Your assistant is/ });
}

function composer(): HTMLElement | null {
  return screen.queryByRole("textbox", { name: "Message" });
}

describe("AssistantGate on a chat with no pod", () => {
  it("should let the person type in a local chat when the chat gate is blocked", () => {
    render(chatPage("blocked", true));

    expect(composer()).toBeTruthy();
    expect(overlay()).toBeNull();
  });

  it("should still hold a pod chat on the getting-ready screen when the chat gate is blocked", () => {
    render(chatPage("blocked", false));

    expect(composer()).toBeNull();
    expect(overlay()).toBeTruthy();
  });

  // The suppression is per page, and this is the one page that always needs a pod: it is about to start one.
  it("should still hold the new-chat screen when the chat gate is blocked, since no page passes it a local chat", () => {
    render(
      <AssistantGate home={home("blocked")} waiting={undefined} theme="system">
        <p>the new-chat screen</p>
      </AssistantGate>
    );

    expect(screen.queryByText("the new-chat screen")).toBeNull();
    expect(overlay()).toBeTruthy();
  });

  it("should leave a local chat exactly as it is when the chat gate passes", () => {
    render(chatPage("open", true, statuses("github", "claude")));

    expect(composer()).toBeTruthy();
    expect(overlay()).toBeNull();
  });

  it("should leave a pod chat exactly as it is when the chat gate passes", () => {
    render(chatPage("open", false, statuses("github", "claude")));

    expect(composer()).toBeTruthy();
    expect(overlay()).toBeNull();
  });
});

describe("the way to the connections from a local chat", () => {
  /**
   * The ask is not dropped with the screen, and this is why it matters: the settings dialog lists GitHub and Claude
   * but offers to connect neither — `offersConnect` is true only for a sign-in the assistant makes on request — so
   * the banner is the only route to the screen that takes those two.
   */
  it("should ask on a banner when nothing is connected, which is the way to the connections screen", () => {
    render(chatPage("blocked", true));

    const banner = screen.getByRole("region", { name: "Connect your accounts" });
    expect(banner.textContent).toContain("GitHub");
    expect(composer()).toBeTruthy();
  });

  it("should open the connections screen from that banner, with the way back to the chat", () => {
    render(chatPage("blocked", true));

    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));

    expect(screen.getByRole("list", { name: "Connections" })).toBeTruthy();
    // Offered, unlike on a held pod chat: the screen here is one the person opened, so it is one they may close.
    fireEvent.click(screen.getByRole("button", { name: "Go to your chats" }));
    expect(overlay()).toBeNull();
    expect(composer()).toBeTruthy();
  });

  it("should close that screen on Escape, which a held pod chat does not", () => {
    render(chatPage("blocked", true));

    fireEvent.click(screen.getByRole("button", { name: "Connect accounts" }));
    fireEvent.keyDown(window, { key: "Escape" });

    expect(overlay()).toBeNull();
    expect(composer()).toBeTruthy();
  });
});
