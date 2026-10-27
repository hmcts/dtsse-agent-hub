// github.com's two device-flow endpoints, faked, for the suites that drive the client as a process and so
// have nowhere to pass a `fetch` in: `GITHUB_OAUTH_HOST` points the flow at this instead. It answers
// form-encoded, as github.com does for a client that does not ask for JSON, so what the client parses here
// is the shape it parses in a pod.
//
// `interval` is 1 rather than github.com's 5, so a poll is two seconds behind the code rather than ten.
import http from "node:http";
import type { AddressInfo } from "node:net";

export type GithubDeviceFlowStubOptions = {
  /** What the sign-in hands over. Not a real credential. */
  token?: string;
  userCode?: string;
  verificationUri?: string;
  intervalS?: number;
  expiresInS?: number;
  /** How many polls answer `authorization_pending` before the token. */
  pendingPolls?: number;
  /** An OAuth error every poll answers with instead, so each code is spent and none is completed. */
  refuseWith?: string;
};

export type GithubDeviceFlowStub = {
  /** The origin to put in `GITHUB_OAUTH_HOST`. */
  listen: () => Promise<string>;
  close: () => Promise<void>;
  /** What the flow asked for, so a test can assert the scopes and the client id a pod signs in with. */
  codeRequests: Record<string, string>[];
  polls: Record<string, string>[];
  reset: () => void;
};

export const STUB_USER_CODE = "7B7F-C198";

export function createGithubDeviceFlowStub({
  token = "gho_stub_token",
  userCode = STUB_USER_CODE,
  verificationUri = "https://github.com/login/device",
  intervalS = 1,
  expiresInS = 900,
  pendingPolls = 0,
  refuseWith
}: GithubDeviceFlowStubOptions = {}): GithubDeviceFlowStub {
  const codeRequests: Record<string, string>[] = [];
  const polls: Record<string, string>[] = [];
  const deviceCode = "stub-device-code";

  const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const values: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(body)) {
        values[key] = value;
      }
      const send = (status: number, text: string) => {
        res.writeHead(status, { "Content-Type": "application/x-www-form-urlencoded" });
        res.end(text);
      };
      if (req.url === "/login/device/code") {
        codeRequests.push(values);
        send(
          200,
          form({
            device_code: deviceCode,
            user_code: userCode,
            verification_uri: verificationUri,
            expires_in: String(expiresInS),
            interval: String(intervalS)
          })
        );
        return;
      }
      if (req.url === "/login/oauth/access_token") {
        polls.push(values);
        if (values.device_code !== deviceCode) {
          send(200, form({ error: "incorrect_device_code", error_description: "The device code is not valid." }));
          return;
        }
        if (refuseWith !== undefined) {
          send(200, form({ error: refuseWith, error_description: "The stub refuses every poll." }));
          return;
        }
        if (polls.length <= pendingPolls) {
          send(200, form({ error: "authorization_pending", error_description: "The authorization request is still pending." }));
          return;
        }
        send(200, form({ access_token: token, token_type: "bearer", scope: "repo,read:org,gist,user:email" }));
        return;
      }
      send(404, form({ error: "not_found" }));
    });
  });

  return {
    listen: () =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    codeRequests,
    polls,
    reset: () => {
      codeRequests.length = 0;
      polls.length = 0;
    }
  };
}
