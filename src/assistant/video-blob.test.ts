import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_CONTAINER, videoBlobSettings, videoBlobs } from "./video-blob.ts";

const ACCOUNT = "https://dtsseagenthubaat.blob.core.windows.net";

describe("videoBlobSettings", () => {
  it("should use the feedback account with a container of its own when no container is named", () => {
    expect(videoBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT })).toEqual({ kind: "identity", accountUrl: ACCOUNT, container: DEFAULT_VIDEO_CONTAINER });
    expect(videoBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT, FEEDBACK_STORAGE_CONTAINER: "feedback" })?.container).toBe("assistant-videos");
  });

  it("should take the container the environment names when Azure accepts it, and refuse it when Azure would not", () => {
    expect(videoBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT, ASSISTANT_VIDEO_STORAGE_CONTAINER: "videos-2" })?.container).toBe("videos-2");
    expect(videoBlobSettings({ FEEDBACK_STORAGE_ACCOUNT_URL: ACCOUNT, ASSISTANT_VIDEO_STORAGE_CONTAINER: "Bad--Name" })).toBeUndefined();
  });

  it("should be undefined when there is no account", () => {
    expect(videoBlobSettings({})).toBeUndefined();
  });
});

describe("videoBlobs", () => {
  it("should answer one client for the same settings when there is storage, and none when there is not", () => {
    expect(videoBlobs({})).toBeUndefined();
    const env = { FEEDBACK_STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true" };
    expect(videoBlobs(env)).toBe(videoBlobs(env));
  });
});
