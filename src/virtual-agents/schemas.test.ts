import { describe, expect, it } from "vitest";
import { applyFailedBody, claimBody, completeBody, loginBody, observedBody, statusBody } from "./schemas.ts";

describe("statusBody", () => {
  it("should accept a phase and keep a detail when one is sent", () => {
    expect(statusBody.parse({ phase: "cloning", detail: " hmcts/pcs-api " })).toEqual({ phase: "cloning", detail: "hmcts/pcs-api" });
  });

  it("should read a blank or missing detail as none", () => {
    expect(statusBody.parse({ phase: "running" })).toEqual({ phase: "running", detail: null });
    expect(statusBody.parse({ phase: "running", detail: "  " })).toEqual({ phase: "running", detail: null });
  });

  it.each([
    ["a phase only the orchestrator decides", { phase: "stopped" }],
    ["a detail over 500 characters", { phase: "running", detail: "x".repeat(501) }]
  ])("should refuse %s", (_label, body) => {
    expect(statusBody.safeParse(body).success).toBe(false);
  });
});

describe("loginBody", () => {
  it("should accept a device-code login with its user code", () => {
    expect(loginBody.parse({ prompt: "device_code", verification_uri: "https://github.com/login/device", user_code: "ABCD-1234", expires_in: 899 })).toEqual({
      prompt: "device_code",
      verification_uri: "https://github.com/login/device",
      user_code: "ABCD-1234",
      expires_in: 899
    });
  });

  it("should accept a paste-code login without a user code", () => {
    expect(loginBody.safeParse({ prompt: "paste_code", verification_uri: "https://claude.ai/oauth/authorize?code=true", expires_in: 600 }).success).toBe(true);
  });

  it.each([
    ["a device-code login without a user code", { prompt: "device_code", verification_uri: "https://github.com/login/device", expires_in: 900 }, "user_code"],
    ["a javascript: URL", { prompt: "paste_code", verification_uri: "javascript:alert(1)", expires_in: 900 }, "verification_uri"],
    ["an http URL", { prompt: "paste_code", verification_uri: "http://github.com/login/device", expires_in: 900 }, "verification_uri"],
    [
      "a user code with markup in it",
      { prompt: "device_code", verification_uri: "https://github.com/login/device", user_code: "<b>", expires_in: 900 },
      "user_code"
    ],
    ["a login lasting over an hour", { prompt: "paste_code", verification_uri: "https://claude.ai/", expires_in: 3601 }, "expires_in"],
    ["an unknown prompt", { prompt: "sms", verification_uri: "https://claude.ai/", expires_in: 60 }, "prompt"]
  ])("should refuse %s", (_label, body, field) => {
    const result = loginBody.safeParse(body);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });
});

describe("completeBody", () => {
  it("should read missing fields as none", () => {
    expect(completeBody.parse({})).toEqual({ account_oid: null, account_label: null });
  });
});

describe("claimBody", () => {
  it("should accept a cluster name and refuse anything else", () => {
    expect(claimBody.parse({ cluster: "cft-preview-01-aks" })).toEqual({ cluster: "cft-preview-01-aks" });
    expect(claimBody.safeParse({ cluster: "a b" }).success).toBe(false);
    expect(claimBody.safeParse({}).success).toBe(false);
  });
});

describe("observedBody", () => {
  it("should accept what the orchestrator saw", () => {
    expect(observedBody.parse({ generation: 3, replicas_ready: 0, pod_phase: "Pending", reason: "ImagePullBackOff" })).toEqual({
      generation: 3,
      replicas_ready: 0,
      pod_phase: "Pending",
      reason: "ImagePullBackOff"
    });
  });

  it.each([
    ["a negative generation", { generation: -1, replicas_ready: 0 }],
    ["a fractional replica count", { generation: 1, replicas_ready: 0.5 }],
    ["a disk_deleted that is not a boolean", { generation: 1, replicas_ready: 0, disk_deleted: "yes" }]
  ])("should refuse %s", (_label, body) => {
    expect(observedBody.safeParse(body).success).toBe(false);
  });
});

describe("applyFailedBody", () => {
  it("should accept the generation and the error when the orchestrator could not apply it", () => {
    expect(applyFailedBody.parse({ generation: 2, error: " GET services/va-1: 403 forbidden " })).toEqual({
      generation: 2,
      error: "GET services/va-1: 403 forbidden"
    });
  });

  it.each([
    ["an empty error", { generation: 1, error: " " }],
    ["an error over 500 characters", { generation: 1, error: "x".repeat(501) }],
    ["no generation", { error: "boom" }]
  ])("should refuse %s", (_label, body) => {
    expect(applyFailedBody.safeParse(body).success).toBe(false);
  });
});
