import { describe, expect, it } from "vitest";
import {
  clientSupports,
  MAX_CLIENT_FEATURE_NAME,
  MAX_CLIENT_FEATURES,
  normaliseClientFeatures,
  podGate,
  podLacks,
  podSupports,
  sessionLacks,
  storedClientFeatures
} from "./client-features.ts";

describe("normaliseClientFeatures", () => {
  it("should sort and de-duplicate the names when a client reports a list", () => {
    expect(normaliseClientFeatures(["attachments", "voice", "attachments"])).toEqual(["attachments", "voice"]);
  });

  it("should keep a name this hub does not know when a newer client reports one", () => {
    expect(normaliseClientFeatures(["some-later-field"])).toEqual(["some-later-field"]);
  });

  it("should keep a pod job's claim when its kind is dotted", () => {
    expect(normaliseClientFeatures(["pod-job:docmosis.load", "lookups"])).toEqual(["lookups", "pod-job:docmosis.load"]);
    expect(podGate({ status: "running", clientFeatures: ["pod-job:docmosis.load"] }, "pod-job:docmosis.load")).toBe("ok");
    expect(podGate({ status: "running", clientFeatures: ["lookups"] }, "pod-job:docmosis.load")).toBe("unsupported");
  });

  it("should drop an entry that is not a valid name rather than refuse the list, so one bad name costs only itself", () => {
    expect(normaliseClientFeatures(["Attachments", "-leading", "has space", "", 7, null, undefined, {}, ["attachments"], "attachments"])).toEqual([
      "attachments"
    ]);
    expect(normaliseClientFeatures(["a".repeat(MAX_CLIENT_FEATURE_NAME)])).toEqual(["a".repeat(MAX_CLIENT_FEATURE_NAME)]);
    expect(normaliseClientFeatures(["a".repeat(MAX_CLIENT_FEATURE_NAME + 1)])).toEqual([]);
  });
});

describe("MAX_CLIENT_FEATURES", () => {
  it("should be the cap the pod client keeps its claim within, so a pod's status report is never refused for it", async () => {
    // Imported by URL so that the hub's typecheck does not take in the client's sources.
    const client: { MAX_CLIENT_FEATURES: number } = await import(new URL("../../packages/agent-hub/src/wire.ts", import.meta.url).href);
    expect(client.MAX_CLIENT_FEATURES).toBe(MAX_CLIENT_FEATURES);
  });
});

describe("storedClientFeatures", () => {
  it("should give null when the column holds no array, which is a client that reported nothing", () => {
    expect(storedClientFeatures(null)).toBeNull();
    expect(storedClientFeatures(undefined)).toBeNull();
    expect(storedClientFeatures("attachments")).toBeNull();
    expect(storedClientFeatures({ attachments: true })).toBeNull();
  });

  it("should give an empty list when a current client reported no features, which is not the same as reporting nothing", () => {
    expect(storedClientFeatures([])).toEqual([]);
  });

  it("should narrow the stored array when the column holds one", () => {
    expect(storedClientFeatures(["voice", "attachments", 3])).toEqual(["attachments", "voice"]);
  });

  it("should read no further than the cap when the column somehow holds more", () => {
    const stored = [...Array(MAX_CLIENT_FEATURES + 10).keys()].map((index) => `f${String(index).padStart(3, "0")}`);

    expect(storedClientFeatures(stored)).toHaveLength(MAX_CLIENT_FEATURES);
  });
});

describe("clientSupports", () => {
  it("should be true only for a feature the stored list names", () => {
    expect(clientSupports(["attachments"], "attachments")).toBe(true);
    expect(clientSupports(["voice"], "attachments")).toBe(false);
    expect(clientSupports([], "attachments")).toBe(false);
  });

  it("should be false for a client that reported nothing, so an old client needs no case of its own", () => {
    expect(clientSupports(null, "attachments")).toBe(false);
    expect(clientSupports(undefined, "attachments")).toBe(false);
    expect(clientSupports("attachments", "attachments")).toBe(false);
  });
});

describe("podSupports", () => {
  it("should read the pod's own claim when it reported one", () => {
    expect(podSupports({ clientFeatures: ["files"], agent: { clientFeatures: [] } }, "files")).toBe(true);
    expect(podSupports({ clientFeatures: ["files"] }, "lookups")).toBe(false);
  });

  it("should not fall back when the pod reported an empty claim", () => {
    expect(podSupports({ clientFeatures: [], agent: { clientFeatures: ["files"] } }, "files")).toBe(false);
  });

  it("should read the main-session agent's claim when the pod reported none", () => {
    expect(podSupports({ clientFeatures: null, agent: { clientFeatures: ["welsh"] } }, "welsh")).toBe(true);
    expect(podSupports({ clientFeatures: null, agent: { clientFeatures: ["files"] } }, "welsh")).toBe(false);
  });

  it("should be false when neither the pod nor a main-session agent claims anything", () => {
    expect(podSupports({ clientFeatures: null, agent: null }, "files")).toBe(false);
    expect(podSupports({ clientFeatures: undefined }, "files")).toBe(false);
  });
});

describe("podGate", () => {
  it("should say waking when the pod is not running, whatever it claimed", () => {
    expect(podGate({ status: "cloning", clientFeatures: ["lookups"] }, "lookups")).toBe("waking");
  });

  it("should say waking when the pod runs but has claimed nothing and no main-session agent has registered", () => {
    expect(podGate({ status: "running", clientFeatures: null, agent: null }, "lookups")).toBe("waking");
    expect(podGate({ status: "running", clientFeatures: "lookups" }, "lookups")).toBe("waking");
  });

  it("should read the pod's own claim, even before a main-session agent registers", () => {
    expect(podGate({ status: "running", clientFeatures: ["lookups"], agent: null }, "lookups")).toBe("ok");
    expect(podGate({ status: "running", clientFeatures: [], agent: { clientFeatures: ["lookups"] } }, "lookups")).toBe("unsupported");
  });

  it("should read the main-session agent's claim when the pod reported none", () => {
    expect(podGate({ status: "running", clientFeatures: null, agent: { clientFeatures: ["welsh"] } }, "welsh")).toBe("ok");
    expect(podGate({ status: "running", clientFeatures: null, agent: { clientFeatures: ["files"] } }, "welsh")).toBe("unsupported");
  });

  it("should say unsupported when the main-session agent registered on a client that claims nothing", () => {
    expect(podGate({ status: "running", clientFeatures: null, agent: { clientFeatures: null } }, "welsh")).toBe("unsupported");
  });

  it("should say waking for a pod job when the running pod has made no claim of its own, whatever its main-session agent claimed", () => {
    expect(podGate({ status: "running", clientFeatures: null, agent: { clientFeatures: ["lookups"] } }, "pod-job:docmosis.load")).toBe("waking");
    expect(podGate({ status: "running", clientFeatures: null, agent: { clientFeatures: null } }, "pod-job:docmosis.load")).toBe("waking");
    expect(podGate({ status: "running", clientFeatures: ["lookups"], agent: { clientFeatures: ["pod-job:docmosis.load"] } }, "pod-job:docmosis.load")).toBe(
      "unsupported"
    );
  });
});

describe("podLacks", () => {
  it("should say a running pod lacks a feature only when its claim leaves the feature out", () => {
    expect(podLacks({ status: "running", clientFeatures: ["lookups"] }, "github-lookups")).toBe(true);
    expect(podLacks({ status: "running", clientFeatures: ["lookups", "github-lookups"] }, "github-lookups")).toBe(false);
  });

  it("should not count a pod that has claimed nothing yet, or is not running, since it boots on the current client", () => {
    expect(podLacks({ status: "running", clientFeatures: null }, "github-lookups")).toBe(false);
    expect(podLacks({ status: "stopped", clientFeatures: ["lookups"] }, "github-lookups")).toBe(false);
  });

  it("should read the main session's claim when the pod reported none of its own", () => {
    expect(podLacks({ status: "running", clientFeatures: null, agent: { clientFeatures: ["lookups"] } }, "github-lookups")).toBe(true);
  });
});

describe("sessionLacks", () => {
  it("should say a running session lacks a feature when its claim leaves the feature out or claims nothing", () => {
    expect(sessionLacks(["stop"], "idle", "plain-prompt")).toBe(true);
    expect(sessionLacks(null, "busy", "plain-prompt")).toBe(true);
  });

  it("should not when the session claims the feature", () => {
    expect(sessionLacks(["plain-prompt"], "idle", "plain-prompt")).toBe(false);
  });

  it("should not count a session that is offline, whose claim may be an earlier session's", () => {
    expect(sessionLacks(["stop"], "offline", "plain-prompt")).toBe(false);
  });
});
