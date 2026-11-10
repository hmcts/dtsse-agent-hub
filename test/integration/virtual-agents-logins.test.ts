import { describe, expect, it, vi } from "vitest";
import * as credentialRoute from "../../src/app/api/virtual/[virtualAgentId]/credentials/[kind]/route.ts";
import * as codeRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/code/route.ts";
import * as completeRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/complete/route.ts";
import * as failedRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/failed/route.ts";
import * as loginRoute from "../../src/app/api/virtual/[virtualAgentId]/login/[kind]/route.ts";
import { putCredential, readCredential } from "../../src/credentials/store.ts";
import { loginViews, storePastedCode } from "../../src/virtual-agents/logins.ts";
import { setDesired } from "../../src/virtual-agents/store.ts";
import { connect, insertUser, prisma } from "./database.ts";
import { jsonOf } from "./routes.ts";
import {
  ALICE,
  AZURE,
  atlassianAuthFor,
  azureCacheFor,
  BOB,
  CLAUDE,
  claim,
  form,
  GITHUB,
  JENKINS,
  localStore,
  pod,
  row,
  SECRET,
  started,
  status,
  virtualAgentSuite
} from "./virtual-agent-suite.ts";

vi.mock("next/headers", async () => {
  const { jar } = await import("./web-session.ts");
  return { cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }) };
});
vi.mock("next/cache", async () => {
  const { revalidated } = await import("./web-session.ts");
  return { revalidatePath: (path: string) => void revalidated.push(path) };
});

const { actAs } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/virtual-agents.ts");

virtualAgentSuite();

describe("logins", () => {
  function startLogin(id: string, token: string, kind: string, body: unknown): Promise<Response> {
    return pod(loginRoute.POST, token, `/api/virtual/${id}/login/${kind}`, { virtualAgentId: id, kind }, "POST", body);
  }

  function fetchCode(id: string, token: string, kind: string): Promise<Response> {
    return pod(codeRoute.GET, token, `/api/virtual/${id}/login/${kind}/code`, { virtualAgentId: id, kind });
  }

  function complete(id: string, token: string, kind: string, body: unknown): Promise<Response> {
    return pod(completeRoute.POST, token, `/api/virtual/${id}/login/${kind}/complete`, { virtualAgentId: id, kind }, "POST", body);
  }

  function failed(id: string, token: string, kind: string, body: unknown): Promise<Response> {
    return pod(failedRoute.POST, token, `/api/virtual/${id}/login/${kind}/failed`, { virtualAgentId: id, kind }, "POST", body);
  }

  async function relayAtlassian(id: string, token: string): Promise<void> {
    await startLogin(id, token, "atlassian", {
      prompt: "device_code",
      verification_uri: "https://auth.atlassian.com/oauth/activate",
      user_code: "WXYZ-9876",
      expires_in: 300
    });
  }

  it("should show a device-code login to its owner alone and mark the agent waiting on them", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      const response = await startLogin(id, token, "github", {
        prompt: "device_code",
        verification_uri: "https://github.com/login/device",
        user_code: "ABCD-1234",
        expires_in: 900
      });

      expect(response.status).toBe(204);
      await expect
        .poll(() => payloads.map((payload) => JSON.parse(payload)))
        .toContainEqual({ type: "virtual_agent", virtual_agent_id: id, owner_oid: ALICE.oid });
    } finally {
      await listener.end();
    }
    expect((await row(id)).status).toBe("awaiting_login");
    expect(await loginViews(prisma, id)).toEqual([
      expect.objectContaining({ kind: "github", prompt: "device_code", userCode: "ABCD-1234", state: "pending", codeWaitingUntil: null })
    ]);
  });

  it("should hand a pasted code to the pod exactly once, keeping it sealed until then", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth/authorize?code=true", expires_in: 900 });
    expect((await fetchCode(id, token, "claude")).status).toBe(204);

    actAs("alice");
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: " pasted#code-123 " }))).toEqual({
      ok: true,
      confirmation: "Sent to your virtual agent"
    });
    const sealed = await prisma.virtualAgentLogin.findFirstOrThrow();
    expect(Buffer.from(sealed.pastedCodeCiphertext!).toString("utf8")).not.toContain("pasted#code-123");
    expect((await loginViews(prisma, id))[0]?.codeWaitingUntil).not.toBeNull();

    const first = await fetchCode(id, token, "claude");
    expect(first.status).toBe(200);
    expect(await jsonOf(first)).toEqual({ code: "pasted#code-123" });
    expect((await fetchCode(id, token, "claude")).status).toBe(204);
    expect(await prisma.virtualAgentLogin.findFirstOrThrow()).toMatchObject({ pastedCodeCiphertext: null, pastedCodeIv: null, pastedCodeTag: null });
  });

  it("should not hand over a pasted code once it has waited longer than ten minutes", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth", expires_in: 3600 });
    await storePastedCode(prisma, ALICE.oid, id, "claude", "late-code", SECRET, new Date(Date.now() - 11 * 60_000));

    expect((await fetchCode(id, token, "claude")).status).toBe(204);
  });

  // The pod withdraws a code it cannot finish reading a token for and then throws, so its next attempt completes
  // a sign-in whose row it has already failed. A state guard added here would break that recovery silently and
  // leave the agent with a token it never stored, so what the pod depends on is pinned rather than assumed.
  it("should complete a login the pod has already reported failed, which is how it recovers from withdrawing one", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });
    expect((await failed(id, token, "github", { state: "failed", detail: "github: the sign-in could not be finished" })).status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("failed");

    expect((await complete(id, token, "github", { account_label: "octocat" })).status).toBe(204);

    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
  });

  it("should refuse a pasted code when it is from someone other than the owner, or for a login not asking for one", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });
    await startLogin(id, token, "claude", { prompt: "paste_code", verification_uri: "https://claude.ai/oauth", expires_in: 900 });

    actAs("bob");
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: "x" }))).toEqual({ ok: false, error: "no such virtual agent" });
    actAs("alice");
    expect(await actions.pasteLoginCode(form({ id, kind: "github", code: "x" }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("no longer waiting")
    });
    expect(await actions.pasteLoginCode(form({ id, kind: "claude", code: "  " }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("paste the code")
    });
    expect(await actions.pasteLoginCode(form({ id, kind: "ssh", code: "x" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await prisma.virtualAgentLogin.count({ where: { NOT: { pastedCodeCiphertext: null } } })).toBe(0);
  });

  it("should wipe the Azure credential, fail the agent and answer 409 when the Azure login was someone else's", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    const response = await complete(id, token, "azure", { account_oid: "someone-else", account_label: "mallory@example.com" });

    expect(response.status).toBe(409);
    expect((await jsonOf(response)).error).toContain("different account");
    expect(await prisma.credential.count()).toBe(0);
    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBeUndefined();
    expect(await row(id)).toMatchObject({ status: "failed", statusDetail: expect.stringContaining("different account") });
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("failed");
  });

  it("should accept the owner's cache saved after the owner's own Azure login was completed", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });

    expect((await complete(id, token, "azure", { account_oid: ALICE.oid })).status).toBe(204);
    const saved = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    expect(saved.status).toBe(204);
    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBe(AZURE);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
    expect((await row(id)).status).toBe("running");
  });

  it("should still refuse someone else's cache saved after a completed Azure login", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await complete(id, token, "azure", { account_oid: ALICE.oid });

    const saved = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", {
      value: azureCacheFor(BOB.oid)
    });

    expect(saved.status).toBe(409);
    expect(await prisma.credential.count()).toBe(0);
    expect((await row(id)).status).toBe("failed");
  });

  it("should treat an Azure login with no account as someone else's", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });

    expect((await complete(id, token, "azure", {})).status).toBe(409);
  });

  it("should complete the owner's own Azure login and label the credential with the account", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "azure", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
    await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/azure`, { virtualAgentId: id, kind: "azure" }, "PUT", { value: AZURE });

    expect((await complete(id, token, "azure", { account_oid: ALICE.oid, account_label: "alice@justice.gov.uk" })).status).toBe(204);

    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
    expect((await prisma.credential.findFirstOrThrow()).accountLabel).toBe("alice@justice.gov.uk");
  });

  it("should complete a GitHub login whatever account it names", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });

    expect((await complete(id, token, "github", { account_label: "alice-gh" })).status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
  });

  it("should complete an Atlassian login as an account other than the owner's, label it, and never fail the agent", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await startLogin(id, token, "atlassian", {
      prompt: "device_code",
      verification_uri: "https://auth.atlassian.com/activate",
      user_code: "WXYZ-9876",
      expires_in: 600
    });
    const saved = await pod(credentialRoute.PUT, token, `/api/virtual/${id}/credentials/atlassian`, { virtualAgentId: id, kind: "atlassian" }, "PUT", {
      value: atlassianAuthFor("someone@example.com", "refresh-one")
    });

    expect(saved.status).toBe(204);
    expect((await complete(id, token, "atlassian", { account_label: "someone@example.com" })).status).toBe(204);

    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
    expect((await prisma.credential.findFirstOrThrow()).accountLabel).toBe("someone@example.com");
    expect((await row(id)).status).not.toBe("failed");
  });

  it("should answer 404 when there is no login of that kind to complete", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await complete(id, token, "github", {})).status).toBe(404);
  });

  it("should record an expired sign-in and stop the agent waiting on its owner when the pod reports one", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);
    expect((await row(id)).status).toBe("awaiting_login");

    const response = await failed(id, token, "atlassian", { state: "expired", detail: "atlassian: the sign-in code ran out before it was used" });

    expect(response.status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("expired");
    expect(await row(id)).toMatchObject({ status: "running", statusDetail: "atlassian: the sign-in code ran out before it was used" });
  });

  it("should show the owner a sign-in that expired rather than the code it relayed", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);
    await failed(id, token, "atlassian", { state: "expired", detail: "atlassian: the sign-in code ran out before it was used" });

    expect(await loginViews(prisma, id)).toEqual([expect.objectContaining({ kind: "atlassian", state: "expired" })]);
  });

  it("should tell the owner's UI about a sign-in the pod gave up on", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);
    const listener = await connect();
    try {
      const payloads: string[] = [];
      listener.on("notification", (message) => payloads.push(message.payload ?? ""));
      await listener.query("LISTEN hub_events");

      await failed(id, token, "atlassian", { state: "expired", detail: null });

      await expect
        .poll(() => payloads.map((payload) => JSON.parse(payload)))
        .toContainEqual({ type: "virtual_agent", virtual_agent_id: id, owner_oid: ALICE.oid });
    } finally {
      await listener.end();
    }
  });

  it("should keep the agent waiting on its owner when another sign-in of theirs is still pending", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);
    await startLogin(id, token, "github", {
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 900
    });

    expect((await failed(id, token, "atlassian", { state: "expired", detail: null })).status).toBe(204);
    expect((await row(id)).status).toBe("awaiting_login");
  });

  it("should record a sign-in that broke rather than ran out when the pod says so", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);

    expect((await failed(id, token, "atlassian", { state: "failed", detail: null })).status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("failed");
  });

  it("should leave a completed sign-in alone when a second report says its code expired", async () => {
    // Two of a pod's sessions can relay the same kind at once and share one twg config, so the loser's report
    // must not take the winner's working sign-in away.
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);
    await complete(id, token, "atlassian", { account_label: "alice@justice.gov.uk" });

    expect((await failed(id, token, "atlassian", { state: "expired", detail: null })).status).toBe(204);
    expect((await prisma.virtualAgentLogin.findFirstOrThrow()).state).toBe("completed");
  });

  it("should answer 404 when there is no sign-in of that kind to report on", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await failed(id, token, "atlassian", { state: "expired", detail: null })).status).toBe(404);
  });

  it("should refuse a reported sign-in outcome that is neither expired nor failed", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await relayAtlassian(id, token);

    expect((await failed(id, token, "atlassian", { state: "completed" })).status).toBe(400);
  });

  it("should refuse a login whose URL is not https", async () => {
    const { id, token } = await started(ALICE, "pcs-api");

    expect((await startLogin(id, token, "github", { prompt: "paste_code", verification_uri: "javascript:alert(1)", expires_in: 900 })).status).toBe(400);
  });
});

describe("signing in again", () => {
  async function storedGithub(): Promise<void> {
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "github", value: GITHUB, via: "pod" });
  }

  it("should delete the credential and restart the pod with a fresh launch token when the agent is running", async () => {
    const { id, token } = await started(ALICE, "pcs-api");
    await storedGithub();
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toEqual({
      ok: true,
      confirmation: "pcs-api is restarting to sign in to GitHub again"
    });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBeUndefined();
    expect(await prisma.credential.count({ where: { ownerOid: ALICE.oid, kind: "github" } })).toBe(0);
    const after = await row(id);
    expect([after.generation, after.podGeneration]).toEqual([before.generation + 1, before.podGeneration + 1]);
    expect(after).toMatchObject({ desired: "running", status: "provisioning", statusDetail: "restarting to sign in to GitHub again" });
    expect((await status(id, token, { phase: "running" })).status).toBe(401);
    const claimed = (await claim()).find((entry) => entry.id === id);
    expect(claimed).toMatchObject({ generation: after.generation, pod_generation: after.podGeneration, desired: "running" });
    expect(claimed?.launch_token).toBeDefined();
    expect((await status(id, claimed!.launch_token!, { phase: "awaiting_login" })).status).toBe(204);
  });

  it("should delete the credential and leave the generation alone when the agent is stopped", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "azure", value: AZURE, via: "pod" });
    await setDesired(prisma, ALICE.oid, id, "stopped");
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "azure" }))).toEqual({ ok: true, confirmation: "pcs-api signs in to Azure when it next starts" });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBeUndefined();
    expect(await row(id)).toMatchObject({ generation: before.generation, desired: "stopped", status: before.status });
  });

  async function requested(id: string, token: string, kind: "azure" | "github"): Promise<unknown> {
    const response = await pod(loginRoute.GET, token, `/api/virtual/${id}/login/${kind}`, { virtualAgentId: id, kind });
    expect(response.status).toBe(200);
    return (await jsonOf(response)).requested;
  }

  function relayAzure(id: string, token: string): Promise<Response> {
    return pod(loginRoute.POST, token, `/api/virtual/${id}/login/azure`, { virtualAgentId: id, kind: "azure" }, "POST", {
      prompt: "device_code",
      verification_uri: "https://microsoft.com/devicelogin",
      user_code: "ABCDEFGHI",
      expires_in: 900
    });
  }

  it("should tell no pod an Azure sign-in was asked for when the owner has not asked on their own licence", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "own-licence");

    expect(await requested(id, token, "azure")).toBe(false);
  });

  it("should tell a gateway pod to relay Azure when the owner has not asked and has none stored", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "gateway");

    expect(await requested(id, token, "azure")).toBe(true);
    expect(await requested(id, token, "github")).toBe(false);
  });

  it("should tell a gateway pod to relay Azure when one is stored, because it asks only once that one has failed to restore", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "gateway");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "azure", value: AZURE, via: "pod" });

    expect(await requested(id, token, "azure")).toBe(true);
  });

  it.each(["own-licence", "gateway"] as const)(
    "should restart the agent and tell its new pod the owner asked for Azure when the owner connects Azure on %s",
    async (route) => {
      const { id } = await started(ALICE, "pcs-api", route);

      actAs("alice");
      expect(await actions.reconnectSignIn(form({ id, kind: "azure" }))).toEqual({ ok: true, confirmation: "pcs-api is restarting to sign in to Azure again" });

      expect(await row(id)).toMatchObject({ desired: "running", status: "provisioning" });
      expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).azureSignInRequestedAt).not.toBeNull();
      const claimed = (await claim()).find((entry) => entry.id === id);
      const token = claimed!.launch_token!;
      expect(await requested(id, token, "azure")).toBe(true);
      // Only Azure is made on request; every other kind a pod relays whenever it has none.
      expect(await requested(id, token, "github")).toBe(false);
    }
  );

  it("should spend the Azure request once its pod relays the sign-in on their own licence", async () => {
    const { id } = await started(ALICE, "pcs-api", "own-licence");
    actAs("alice");
    await actions.reconnectSignIn(form({ id, kind: "azure" }));
    const token = (await claim()).find((entry) => entry.id === id)!.launch_token!;

    expect((await relayAzure(id, token)).status).toBe(204);
    expect(await requested(id, token, "azure")).toBe(false);
    expect((await row(id)).status).toBe("awaiting_login");
  });

  it("should go on telling a gateway pod to relay Azure after one relay, so its next boot relays again", async () => {
    const { id, token } = await started(ALICE, "pcs-api", "gateway");

    expect((await relayAzure(id, token)).status).toBe(204);
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).azureSignInRequestedAt).toBeNull();
    expect(await requested(id, token, "azure")).toBe(true);
  });

  it("should keep the stored credential but still ask and restart when the owner connects with keep=stored", async () => {
    const { id } = await started(ALICE, "pcs-api", "own-licence");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "azure", value: AZURE, via: "pod" });
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "azure", keep: "stored" }))).toEqual({
      ok: true,
      confirmation: "pcs-api is restarting to sign in to Azure again"
    });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBe(AZURE);
    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).azureSignInRequestedAt).not.toBeNull();
    expect(await row(id)).toMatchObject({ desired: "running", status: "provisioning", generation: before.generation + 1 });
  });

  it("should delete the stored credential when the owner connects without keep=stored", async () => {
    const { id } = await started(ALICE, "pcs-api", "own-licence");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "azure", value: AZURE, via: "pod" });

    actAs("alice");
    await actions.reconnectSignIn(form({ id, kind: "azure", keep: "nothing" }));

    expect(await readCredential(prisma, localStore(), ALICE.oid, "azure")).toBeUndefined();
  });

  it("should keep the Azure request for its next start when the owner connects Azure on a stopped agent", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await setDesired(prisma, ALICE.oid, id, "stopped");

    actAs("alice");
    await actions.reconnectSignIn(form({ id, kind: "azure" }));

    expect((await prisma.virtualAgent.findUniqueOrThrow({ where: { id } })).azureSignInRequestedAt).not.toBeNull();
  });

  it("should delete the Atlassian sign-in and restart the agent when the owner signs in to Atlassian again", async () => {
    const { id } = await started(ALICE, "pcs-api");
    const value = atlassianAuthFor("alice@justice.gov.uk", "refresh-one");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "atlassian", value, via: "pod" });

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "atlassian" }))).toEqual({
      ok: true,
      confirmation: "pcs-api is restarting to sign in to Atlassian again"
    });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "atlassian")).toBeUndefined();
    expect(await row(id)).toMatchObject({ desired: "running", status: "provisioning", statusDetail: "restarting to sign in to Atlassian again" });
  });

  // A lapsed Claude sign-in is mended the same way: with no token stored, the new pod drives `claude setup-token` and
  // relays its link, which is the only way in for someone without Claude Code to make a token with.
  it("should delete the Claude token and restart the agent when the owner signs in to Claude again", async () => {
    const { id } = await started(ALICE, "pcs-api", "own-licence");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "claude", value: CLAUDE, via: "web" });

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "claude" }))).toEqual({ ok: true, confirmation: "pcs-api is restarting to sign in to Claude again" });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "claude")).toBeUndefined();
    expect(await row(id)).toMatchObject({ desired: "running", status: "provisioning", statusDetail: "restarting to sign in to Claude again" });
  });

  it("should delete nothing and restart nothing when the owner of a gateway agent asks to sign in to Claude again", async () => {
    const { id } = await started(ALICE, "pcs-api", "gateway");
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "claude", value: CLAUDE, via: "web" });
    const before = await row(id);

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "claude" }))).toEqual({
      ok: false,
      error: "that virtual agent reaches Claude through the HMCTS AI Gateway, not your own licence"
    });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "claude")).toBe(CLAUDE);
    expect(await row(id)).toMatchObject({ desired: before.desired, status: before.status, statusDetail: before.statusDetail });
  });

  it("should delete nothing and restart nothing when someone other than the owner asks", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await storedGithub();
    await insertUser(BOB);
    const before = await row(id);

    actAs("bob");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toEqual({ ok: false, error: "no such virtual agent" });

    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
    expect((await row(id)).generation).toBe(before.generation);
  });

  it("should refuse when the kind is not a sign-in, or the agent is being deleted", async () => {
    const { id } = await started(ALICE, "pcs-api");
    await storedGithub();
    await putCredential(prisma, localStore(), { actorOid: ALICE.oid, ownerOid: ALICE.oid, kind: "jenkins", value: JENKINS, via: "web" });

    actAs("alice");
    expect(await actions.reconnectSignIn(form({ id, kind: "jenkins" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await actions.reconnectSignIn(form({ id: "", kind: "github" }))).toEqual({ ok: false, error: "no sign-in was named" });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "jenkins")).toBe(JENKINS);

    await setDesired(prisma, ALICE.oid, id, "deleted");
    expect(await actions.reconnectSignIn(form({ id, kind: "github" }))).toMatchObject({ ok: false, error: expect.stringContaining("being deleted") });
    expect(await readCredential(prisma, localStore(), ALICE.oid, "github")).toBe(GITHUB);
  });

  it("should refuse when virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    actAs("alice");

    expect(await actions.reconnectSignIn(form({ id: "x", kind: "github" }))).toMatchObject({ ok: false, error: expect.stringContaining("not available") });
  });
});
