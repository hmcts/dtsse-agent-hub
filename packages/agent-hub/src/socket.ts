import net from "node:net";

export const NO_MESSAGING_TOKEN =
  "CLAUDE_CODE_MESSAGING_TOKEN is not set, so no message from agent-hub could be delivered to this session. Claude Code gives it only to its own processes (hooks, the Bash tool): enable comms with /enable-comms inside the session, not from another shell";

export type DeliverOptions = {
  timeoutMs?: number;
};

// Opens the connection only when there is something to send: the inbox closes idle
// connections after 30s.
export function deliverToSocket(
  socketPath: string | null | undefined,
  token: string | null | undefined,
  content: string,
  { timeoutMs = 5000 }: DeliverOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!socketPath) {
      return reject(new Error("no messaging socket for this session"));
    }
    if (!token) {
      return reject(new Error(NO_MESSAGING_TOKEN));
    }
    const conn = net.createConnection(socketPath);
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => finish(new Error(`socket write timed out after ${timeoutMs}ms`)), timeoutMs);
    conn.on("error", (err) => finish(err));
    conn.on("connect", () => {
      const lines = `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({
        type: "user",
        message: { role: "user", content }
      })}\n`;
      conn.end(lines, () => finish());
    });
  });
}
