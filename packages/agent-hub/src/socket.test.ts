import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliverToSocket, NO_MESSAGING_TOKEN } from "./socket.ts";

type Inbox = { socketPath: string; received: () => string; close: () => Promise<void> };

const open: Inbox[] = [];

// A stand-in for Claude Code's messaging socket. `read: false` leaves the connection paused, so a payload
// bigger than the kernel's buffer never flushes and the write blocks.
async function inbox({ read = true }: { read?: boolean } = {}): Promise<Inbox> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-socket-"));
  const socketPath = path.join(dir, "inbox.sock");
  let text = "";
  const connections: net.Socket[] = [];
  const server = net.createServer((conn) => {
    connections.push(conn);
    if (read) {
      conn.on("data", (chunk) => {
        text += chunk;
      });
    } else {
      conn.pause();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve());
  });
  const handle: Inbox = {
    socketPath,
    received: () => text,
    close: () =>
      new Promise<void>((resolve) => {
        // A paused connection is still open after a timed-out write, and `close` waits for every one of them.
        for (const conn of connections) {
          conn.destroy();
        }
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      })
  };
  open.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of open.splice(0)) {
    await handle.close();
  }
});

describe("deliverToSocket", () => {
  it("should write an auth line and a user message when the socket accepts the connection", async () => {
    // Arrange
    const server = await inbox();

    // Act
    await deliverToSocket(server.socketPath, "tok-123", "hello there");

    // Assert
    await expect.poll(() => server.received().split("\n").filter(Boolean).length).toBe(2);
    const [auth, user] = server.received().split("\n").filter(Boolean);
    expect(JSON.parse(auth as string)).toEqual({ type: "auth", token: "tok-123" });
    expect(JSON.parse(user as string)).toEqual({ type: "user", message: { role: "user", content: "hello there" } });
  });

  it("should reject when the session has no messaging socket", async () => {
    // Act and assert
    await expect(deliverToSocket(null, "tok-123", "hello")).rejects.toThrow("no messaging socket for this session");
  });

  it("should reject with the enable-comms hint when there is no messaging token", async () => {
    // Arrange
    const server = await inbox();

    // Act and assert
    await expect(deliverToSocket(server.socketPath, "", "hello")).rejects.toThrow(NO_MESSAGING_TOKEN);
  });

  it("should reject when the socket cannot be connected to", async () => {
    // Arrange
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-socket-"));

    // Act and assert
    await expect(deliverToSocket(path.join(dir, "missing.sock"), "tok-123", "hello")).rejects.toThrow(/ENOENT/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("should reject when the write does not finish inside the timeout", async () => {
    // Arrange
    const server = await inbox({ read: false });

    // Act and assert
    await expect(deliverToSocket(server.socketPath, "tok-123", "x".repeat(8 * 1024 * 1024), { timeoutMs: 100 })).rejects.toThrow(
      "socket write timed out after 100ms"
    );
  });
});
