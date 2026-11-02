// The mock hub and fake pod the sign-in suites run against: one virtual agent whose launch token the hub knows,
// and pod shims pointed at it. What a test leaves on the agent's record and in the pod is cleared after it, and
// the hub and the pod's HOME go when the file's tests are done.
import { afterAll, afterEach } from "vitest";
import { createApi } from "../api.ts";
import { createMockHub, type MockHub } from "./mock-hub.ts";
import { createPodShims, podSecrets, usePodEnv } from "./pod-shims.ts";

export const SIGN_IN_VID = "va-sign-in";
export const SIGN_IN_OWNER = { oid: "oid-owner", name: "Olive Owner", email: "olive@example.com" };
export const SIGN_IN_LAUNCH = podSecrets.launchToken;

/** Call at the top level of a test file, before its `describe`s, so the hooks it adds apply to every test. */
export async function useSignInHub() {
  const hub = createMockHub({ pingMs: 5000, launchTokens: { [SIGN_IN_LAUNCH]: { virtualId: SIGN_IN_VID, owner: SIGN_IN_OWNER } } });
  const url = await hub.listen();
  const pod = createPodShims({ virtualId: SIGN_IN_VID, hubUrl: url });
  const restoreEnv = usePodEnv(pod.home);
  const virtual = () => hub.virtuals.get(SIGN_IN_VID) as NonNullable<ReturnType<MockHub["virtuals"]["get"]>>;

  afterEach(() => {
    const v = virtual();
    v.status.length = 0;
    v.prompts.length = 0;
    v.completes.length = 0;
    v.loginFailures.length = 0;
    v.signInRequests.clear();
    v.credentials.clear();
    v.codes.clear();
    pod.reset();
  });

  afterAll(async () => {
    await hub.close();
    restoreEnv();
    pod.cleanup();
  });

  return { hub, url, pod, virtual, api: () => createApi({ baseUrl: url, launchToken: SIGN_IN_LAUNCH }) };
}
