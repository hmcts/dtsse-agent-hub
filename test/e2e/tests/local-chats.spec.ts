import { expect, test } from "@playwright/test";
import {
  asPersona,
  chatPersona,
  connectForChat,
  dismissGettingReady,
  openLocalChat,
  readAgentStream,
  registerAgent,
  setAgentStatus,
  type TranscriptEntry,
  unique,
  uploadTranscript
} from "./hub";

/**
 * A Claude Code session on a developer's own computer, as the Assistant shows it.
 *
 * Such a session registers as nobody's pod and names no conversation, and the hub gives it an `assistant_conversation`
 * with no virtual agent behind it, titled after the session. So every spec here makes its chat by registering an
 * agent through the agent API and then reads it in the web UI; nothing runs a pod.
 *
 * Two skips, both about the deployment rather than a test put aside. `registerAgent` answers `undefined` where agent
 * authentication is on, which is preview and AAT, so no spec here can make a session at all. And `/assistant` answers
 * 404 while `VIRTUAL_AGENTS_ENABLED` is `"false"`, which is every environment `Jenkinsfile_nightly` targets; a local
 * chat is inside the Assistant, so it is behind that flag like the rest of it.
 *
 * Every spec names its person with `chatPersona` and connects their accounts, because the Assistant renders no chat at
 * all while it is asking for those — a local chat does not need them, but the screen in front of it is not local.
 */

const CANNOT_REGISTER = "this deployment checks real agent tokens, so the suite cannot register an agent";
const ASSISTANT_OFF = "the Assistant runs on a virtual agent, which is off on this deployment";

/** Spaced a second apart inside the last minute, so the thread reads in the order the entries are written here. */
function at(second: number): string {
  return new Date(Date.now() - 60_000 + second * 1000).toISOString();
}

/**
 * One turn of a developer's own session as its client uploads it: what they typed, the one tool call it made, what
 * that call answered, and what it told them. `sampleTranscript` is not this — it is built for the hub's agent page
 * and carries a redacted call and a failed result, where these specs need a single plainly named call whose output
 * is a string nothing else on the page could be.
 */
function turn(prefix: string, words: { prompt: string; command: string; output: string; answer: string }): TranscriptEntry[] {
  return [
    { key: `${prefix}:1`, role: "user", content: { text: words.prompt }, occurred_at: at(0) },
    { key: `${prefix}:2`, role: "tool_use", content: { id: `${prefix}-t1`, name: "Bash", input: { command: words.command } }, occurred_at: at(1) },
    { key: `${prefix}:3`, role: "tool_result", content: { tool_use_id: `${prefix}-t1`, output: words.output, is_error: false }, occurred_at: at(2) },
    { key: `${prefix}:4`, role: "assistant", content: { text: words.answer }, occurred_at: at(3) }
  ];
}

test.describe("local chats @regression", () => {
  test("should list a session on the person's own computer beside the chats that run on one @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("list");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      expect(response?.status()).toBe(200);
      await dismissGettingReady(page);

      const chats = page.getByRole("navigation", { name: "Chats" });
      // Created as the session registered, so it is today's.
      await expect(chats.getByRole("heading", { level: 2, name: "Today" })).toBeVisible();
      // The marker is words before an icon, which is the whole point of it: a small laptop outline says nothing on
      // its own. They lead the title, so the row's accessible name is the two joined.
      const row = chats.getByRole("link", { name: `On your computer: ${name}` });
      await expect(row).toBeVisible();
      expect(await row.getAttribute("href")).toMatch(/^\/assistant\/[0-9a-f-]{36}$/);
    } finally {
      await context.close();
    }
  });

  test("should read as a conversation: the prompt, the answer, and a tool row that never shows its output @regression", async ({
    browser,
    baseURL,
    request
  }) => {
    const persona = chatPersona("read");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    const words = {
      prompt: `why did that delivery expire ${unique("q")}`,
      command: `yarn vitest run ${unique("cmd")}`,
      output: `tool-output-${unique("o")}`,
      answer: `It ran on the offline clock ${unique("a")}`
    };
    expect(await uploadTranscript(request, persona, agent!, turn(unique("t"), words))).toBe(4);
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      const thread = page.getByRole("list", { name: "Conversation" });
      // The prompt was typed at the laptop, so it is a transcript entry rather than a message the hub carried: a
      // chat with a pod shows no `user` entry at all, and showing this one is what makes the chat a conversation.
      await expect(thread.getByText(words.prompt)).toBeVisible();
      await expect(thread.getByText(words.answer)).toBeVisible();
      // One quiet row for the call: the tool's name, and `toolSummary`'s one line of what it was given.
      await expect(thread.getByText("Bash", { exact: true })).toHaveCount(1);
      await expect(thread.getByText(words.command)).toBeVisible();
      // And never what came back. A tool result is the session's working-out, and the row is there to say what it
      // did: no `tool_result` entry becomes a thread item, collapsed or otherwise, so the output is nowhere at all.
      await expect(page.getByText(words.output)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("should offer none of the controls that instruct a pod, and create no virtual agent @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("pod");
    const name = unique("laptop");
    // Claiming `stop`, so the only thing left standing between the session and a Stop button is having a pod to send
    // the interrupt to. Without the claim the button would be missing for a reason that has nothing to do with this.
    const agent = await registerAgent(request, persona, name, ["stop"]);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      // `/hub/virtual` is behind the same flag as the Assistant, and is read first deliberately: opening `/assistant`
      // creates the person their own assistant, so after that visit they have one. What this asserts is that
      // registering a session on a laptop created none — the chat it made has no pod and asked for no pod.
      const virtual = await page.goto("/hub/virtual");
      test.skip(virtual?.status() === 404, "virtual agents are off on this deployment");
      await expect(page.getByText("You have no virtual agents.")).toBeVisible();

      await setAgentStatus(request, persona, agent!, "busy");
      await page.goto("/assistant");
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      // Working, which is the state a chat on a pod offers its Stop in.
      await expect(page.getByText("Thinking")).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

      // And no way in to attaching a file, which this chat cannot take: the frame that carries one is a pod's. The
      // composer's button is named for what it can still do rather than left offering something that is refused.
      await expect(page.getByRole("button", { name: "Attach a file or add a template" })).toHaveCount(0);
      const add = page.getByRole("button", { name: "Add a template", exact: true });
      await expect(add).toBeVisible();
      await add.click();
      await expect(page.getByRole("menuitem", { name: "Attach files" })).toHaveCount(0);
      await expect(page.getByLabel("Files to attach")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("should carry a message typed here to the session, on the stream the session reads @regression", async ({ browser, baseURL, request }) => {
    // One connection of the agent's stream ends at the server's stream lifetime, 25 seconds by default, and a
    // Playwright API request reads a response to its end: see `readAgentStream`.
    test.setTimeout(150_000);
    const persona = chatPersona("send");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      const body = `please re-run the migration ${unique("msg")}`;
      await page.getByRole("textbox", { name: "Message" }).fill(body);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByRole("list", { name: "Conversation" }).getByText(body)).toBeVisible();

      // It reaches the session as an ordinary direct message, queued as a delivery until the session acks it, and
      // replayed on every connection the session opens. Nothing here acks it, so one read is enough to find it.
      expect(await readAgentStream(request, persona, agent!)).toContain(body);
    } finally {
      await context.close();
    }
  });

  test("should keep the message box live while the session is away, and say the message is kept @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("away");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    await setAgentStatus(request, persona, agent!, "offline");
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      await openLocalChat(page, name);

      // Nothing starts a session on somebody's laptop, so the page cannot offer to start one or to queue for a free
      // assistant. All it can say is what becomes of the message, and the bound the sweep actually enforces.
      await expect(page.getByText("This chat is a Claude Code session on your own computer, and it is not connected.")).toBeVisible();
      await expect(page.getByText("for up to 24 hours offline")).toBeVisible();
      // Said rather than shut: there is something to be gained by typing to a laptop that is away.
      await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    } finally {
      await context.close();
    }
  });

  test("should let the person share a local chat, with its prompts, and nobody else read it @regression", async ({ browser, baseURL, request }) => {
    const owner = chatPersona("own");
    const friend = chatPersona("friend");
    const stranger = chatPersona("else");
    const name = unique("laptop");
    const agent = await registerAgent(request, owner, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    const words = {
      prompt: `which repo was that in ${unique("q")}`,
      command: `rg --files ${unique("cmd")}`,
      output: `tool-output-${unique("o")}`,
      answer: `The one you were already in ${unique("a")}`
    };
    expect(await uploadTranscript(request, owner, agent!, turn(unique("t"), words))).toBe(4);
    await connectForChat(request, owner);

    const theirs = await asPersona(browser, owner, baseURL!);
    const recipient = await asPersona(browser, friend, baseURL!);
    const outsider = await asPersona(browser, stranger, baseURL!);
    try {
      const page = await theirs.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      const path = await openLocalChat(page, name);

      // Only people who have used the hub can be named, so the recipient loads a page first: that is what records
      // them, and it is the hub's own page rather than the Assistant, which would give them an assistant they have
      // no use for.
      const friendsPage = await recipient.newPage();
      await friendsPage.goto("/hub");

      await page.goto(`${path}?share=1`);
      const dialog = page.getByRole("dialog", { name: "Share this chat" });
      await dialog.getByLabel("Who can read it").fill(friend);
      await dialog.getByRole("option", { name: new RegExp(friend) }).click();
      await expect(dialog.getByRole("list", { name: "Shared with" }).getByText(new RegExp(friend))).toBeVisible();

      const shared = `/assistant/shared/${path.split("/").at(-1)}`;
      expect((await friendsPage.goto(shared))?.status()).toBe(200);
      const thread = friendsPage.getByRole("list", { name: "Conversation" });
      // The questions as well as the answers: a recipient reading a laptop chat would otherwise have had a monologue,
      // since the prompts there are the session's own transcript entries.
      await expect(thread.getByText(words.prompt)).toBeVisible();
      await expect(thread.getByText(words.answer)).toBeVisible();
      // A share carries the words and nothing else: a tool row names a path or a command on the owner's own disk.
      await expect(friendsPage.getByText(words.command)).toHaveCount(0);
      await expect(friendsPage.getByText(words.output)).toHaveCount(0);

      // The link reaches a share; it does not grant one.
      const outsidersPage = await outsider.newPage();
      expect((await outsidersPage.goto(shared))?.status()).toBe(404);
    } finally {
      await theirs.close();
      await recipient.close();
      await outsider.close();
    }
  });

  test("should leave the session running when its chat is removed @regression", async ({ browser, baseURL, request }) => {
    const persona = chatPersona("gone");
    const name = unique("laptop");
    const agent = await registerAgent(request, persona, name);
    test.skip(agent === undefined, CANNOT_REGISTER);
    const words = {
      prompt: `is the sweep still collecting these ${unique("q")}`,
      command: `yarn test ${unique("cmd")}`,
      output: `tool-output-${unique("o")}`,
      answer: `Not any more ${unique("a")}`
    };
    const entries = turn(unique("t"), words);
    expect(await uploadTranscript(request, persona, agent!, entries)).toBe(4);
    await connectForChat(request, persona);

    const context = await asPersona(browser, persona, baseURL!);
    try {
      const page = await context.newPage();
      const response = await page.goto("/assistant");
      test.skip(response?.status() === 404, ASSISTANT_OFF);
      await dismissGettingReady(page);
      const path = await openLocalChat(page, name);

      // The chat's own menu, named so it is not the sidebar row's.
      await page.getByRole("button", { name: "Chat options" }).click();
      await page.getByRole("menuitem", { name: "Delete chat" }).click();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.waitForURL(/\/assistant$/);
      await expect(page.getByRole("navigation", { name: "Chats" }).getByRole("link", { name: `On your computer: ${name}` })).toHaveCount(0);
      expect((await page.goto(path))?.status()).toBe(404);

      // The session on the laptop is untouched. Removing the chat detaches it rather than deleting it, because the
      // conversation row's foreign key cascades: deleting it would have taken the live agent, its whole transcript,
      // its subscriptions and every direct message to or from it, including board messages with colleagues.
      //
      // Its agent still answers — an upload to an agent that had gone would be a 404 — and still holds what it had
      // sent, which is why re-sending those entries is accepted as nothing new rather than stored again.
      expect(await uploadTranscript(request, persona, agent!, entries)).toBe(0);
      expect((await page.goto(`/hub/agents/${agent}`))?.status()).toBe(200);
      await expect(page.getByRole("list", { name: "Conversation" }).getByText(words.prompt)).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
