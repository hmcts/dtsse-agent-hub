// The pod's Claude sign-in, against the mock hub with fake claude and script(1) on PATH that print what the real ones
// print. No real sign-in is ever started, and every assertion that a secret stays off stderr is kept from the
// workspace suite.
import { describe, expect, it } from "vitest";
import { AUTHORIZE_URL, CLAUDE_OUTPUT, captureStderr, captureStderrOfFailure, podSecrets } from "../__fixtures__/pod-shims.ts";
import { useSignInHub } from "../__fixtures__/sign-in-hub.ts";
import { claudeLogin, findClaudeToken, parseClaudeAuthorizeUrl } from "./claude-login.ts";

const CLAUDE_TOKEN = podSecrets.claudeToken;

const { pod, virtual, api } = await useSignInHub();

describe("parseClaudeAuthorizeUrl", () => {
  it("should take the URL from the OSC 8 hyperlink when setup-token draws its TUI", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl(CLAUDE_OUTPUT)).toBe(AUTHORIZE_URL);
  });

  it("should take it from the plain text when there is no hyperlink", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl(`\x1b[2mUse the url below\x1b[22m\r\n${AUTHORIZE_URL}\r\n`)).toBe(AUTHORIZE_URL);
  });

  it("should be null when nothing like a sign-in link has been printed", () => {
    // Act & Assert
    expect(parseClaudeAuthorizeUrl("Opening browser to sign in…")).toBeNull();
  });
});

describe("findClaudeToken", () => {
  it("should find the token through the TUI's bold escapes when setup-token prints one", () => {
    // Act & Assert
    expect(findClaudeToken(`Your OAuth token:\r\n \x1b[1m${CLAUDE_TOKEN}\x1b[22m\r\n`)).toBe(CLAUDE_TOKEN);
  });

  it("should be null while only the sign-in prompt has been printed", () => {
    // Act & Assert
    expect(findClaudeToken(CLAUDE_OUTPUT)).toBeNull();
  });
});

describe("claudeLogin", () => {
  it("should relay the authorize URL, type the pasted code into the TUI and store the token", async () => {
    // Arrange
    virtual().codes.set("claude", "good-code#state");

    // Act
    const { result, stderr } = await captureStderr(() => claudeLogin({ api: api(), env: pod.env({ FAKE_CLAUDE_TOKEN: CLAUDE_TOKEN }), pollMs: 50 }));

    // Assert
    expect(result).toBe("signed-in");
    expect(virtual().prompts).toEqual([{ kind: "claude", prompt: "paste_code", verification_uri: AUTHORIZE_URL, expires_in: 600 }]);
    expect(virtual().completes).toEqual([{ kind: "claude" }]);
    expect(virtual().credentials.get("claude")).toBe(CLAUDE_TOKEN);
    expect(stderr).not.toContain(CLAUDE_TOKEN);
  });

  it("should do nothing when the hub already holds a token", async () => {
    // Arrange
    virtual().credentials.set("claude", CLAUDE_TOKEN);

    // Act
    const result = await claudeLogin({ api: api(), env: pod.env() });

    // Assert
    expect(result).toBe("stored");
    expect(virtual().prompts).toHaveLength(0);
  });

  it("should fall back to waiting for a token stored on the hub when no URL appears", async () => {
    // Arrange
    pod.shim("script", "sleep 30");
    try {
      setTimeout(() => virtual().credentials.set("claude", CLAUDE_TOKEN), 400);

      // Act
      const { result } = await captureStderr(() => claudeLogin({ api: api(), env: pod.env(), pollMs: 50, fallbackPollMs: 50, urlTimeoutMs: 200 }));

      // Assert
      expect(result).toBe("stored");
      expect(virtual().status.at(-1)?.phase).toBe("awaiting_credentials");
      expect(virtual().status.at(-1)?.detail).toMatch(/\/assistant\?settings=connections$/);
    } finally {
      pod.scriptShim();
    }
  });

  it("should fail when the TUI rejects the pasted code and prints no token", async () => {
    // Arrange: the fake script(1) exits non-zero on a code it does not accept.
    virtual().codes.set("claude", "wrong-code");

    // Act
    const { error } = await captureStderrOfFailure(() =>
      claudeLogin({ api: api(), env: pod.env({ FAKE_CLAUDE_TOKEN: CLAUDE_TOKEN }), pollMs: 20, tokenTimeoutMs: 2000 })
    );

    // Assert
    expect((error as Error).message).toBe("claude: setup-token printed no token after the code was entered");
    expect(virtual().credentials.has("claude")).toBe(false);
  });

  it("should give up when setup-token exits before the owner pastes a code", async () => {
    // Arrange: the TUI prints its link and then gives up, and no code is ever stored.
    pod.shim("script", 'cat "$SHIM_STATE/claude.out"; sleep 1');
    try {
      // Act
      const { error } = await captureStderrOfFailure(() => claudeLogin({ api: api(), env: pod.env(), pollMs: 20 }));

      // Assert
      expect((error as Error).message).toBe("claude: no code was pasted before the sign-in expired");
      expect(virtual().prompts).toHaveLength(1);
    } finally {
      pod.scriptShim();
    }
  });
});
