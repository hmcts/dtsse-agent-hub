import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKube, FIELD_MANAGER, inClusterConfig, type Kube, KubeError, type StatefulSet } from "./kube.ts";

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let server: Server;
let port: number;
let dir: string;
let seen: Seen[] = [];
let answer: (seen: Seen, response: ServerResponse) => void = (_seen, response) => response.writeHead(200).end("{}");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kube-test-"));
  server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const entry = { method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  seen = [];
  answer = (_seen, response) => response.writeHead(200).end("{}");
});

function kube(timeoutMs?: number): Kube {
  writeFileSync(join(dir, "token"), "first-token\n");
  return createKube({ host: "127.0.0.1", port, namespace: "virtual-agents", tokenFile: join(dir, "token"), request, timeoutMs });
}

function reply(status: number, body: unknown): typeof answer {
  return (_seen, response) => response.writeHead(status, { "content-type": "application/json" }).end(typeof body === "string" ? body : JSON.stringify(body));
}

const SET: StatefulSet = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "va-1" }, spec: { replicas: 1 } };

describe("createKube", () => {
  it("should get a StatefulSet from the apps API in its namespace with the ServiceAccount token", async () => {
    answer = reply(200, { metadata: { name: "va-1" } });

    expect(await kube().get("statefulsets", "va-1")).toEqual({ metadata: { name: "va-1" } });
    expect(seen[0]).toMatchObject({ method: "GET", url: "/apis/apps/v1/namespaces/virtual-agents/statefulsets/va-1" });
    expect(seen[0]!.headers.authorization).toBe("Bearer first-token");
  });

  it("should get core resources from the core API", async () => {
    await kube().get("pods", "va-1-0");
    await kube().get("pods", "va-1-1");

    expect(seen.map((entry) => entry.url)).toEqual(["/api/v1/namespaces/virtual-agents/pods/va-1-0", "/api/v1/namespaces/virtual-agents/pods/va-1-1"]);
  });

  it("should be null when the resource is not found", async () => {
    answer = reply(404, { message: "not found" });

    expect(await kube().get("pods", "missing")).toBeNull();
  });

  it("should throw the API's message when a get fails otherwise", async () => {
    answer = reply(403, { message: "pods is forbidden" });

    await expect(kube().get("pods", "x")).rejects.toThrow(/403 pods is forbidden/);
  });

  it("should read the token file again on every call when it has been rotated", async () => {
    const client = kube();
    await client.get("pods", "a");
    writeFileSync(join(dir, "token"), "second-token");
    await client.get("pods", "a");

    expect(seen.map((entry) => entry.headers.authorization)).toEqual(["Bearer first-token", "Bearer second-token"]);
  });

  it("should list by label selector and return the items", async () => {
    answer = reply(200, { items: [{ metadata: { name: "a" } }] });

    expect(await kube().list("statefulsets", "app.kubernetes.io/managed-by=agent-hub-orchestrator")).toEqual([{ metadata: { name: "a" } }]);
    expect(seen[0]!.url).toBe("/apis/apps/v1/namespaces/virtual-agents/statefulsets?labelSelector=app.kubernetes.io%2Fmanaged-by%3Dagent-hub-orchestrator");
  });

  it("should list nothing when the API returns no items", async () => {
    expect(await kube().list("pods", "a=b")).toEqual([]);
  });

  it("should apply server-side as the orchestrator's field manager, forcing ownership", async () => {
    answer = reply(200, SET);

    expect(await kube().apply("statefulsets", SET)).toEqual(SET);
    expect(seen[0]).toMatchObject({
      method: "PATCH",
      url: `/apis/apps/v1/namespaces/virtual-agents/statefulsets/va-1?fieldManager=${FIELD_MANAGER}&force=true`,
      body: JSON.stringify(SET)
    });
    expect(seen[0]!.headers["content-type"]).toBe("application/apply-patch+yaml");
  });

  it("should throw a KubeError with the status when an apply is refused", async () => {
    answer = reply(422, { message: "spec: Forbidden" });

    const failure = await kube()
      .apply("statefulsets", SET)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KubeError);
    expect(failure).toMatchObject({ status: 422, message: expect.stringContaining("spec: Forbidden") });
  });

  it("should fall back to the start of the body when an error is not a Status", async () => {
    answer = reply(500, "upstream connect error");

    await expect(kube().list("pods", "a=b")).rejects.toThrow(/500 upstream connect error/);
  });

  it("should fall back to the body when an error is JSON without a message", async () => {
    answer = reply(500, { code: 500 });

    await expect(kube().list("pods", "a=b")).rejects.toThrow(/500 \{"code":500\}/);
  });

  it("should delete in the background and say it did when the resource was there", async () => {
    expect(await kube().delete("statefulsets", "va-1")).toBe(true);
    expect(seen[0]).toMatchObject({ method: "DELETE", url: "/apis/apps/v1/namespaces/virtual-agents/statefulsets/va-1" });
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ propagationPolicy: "Background" });
  });

  it("should say it deleted nothing when the resource was already gone", async () => {
    answer = reply(404, { message: "gone" });

    expect(await kube().delete("statefulsets", "va-1")).toBe(false);
  });

  it("should throw when a delete is refused", async () => {
    answer = reply(403, { message: "forbidden" });

    await expect(kube().delete("statefulsets", "va-1")).rejects.toThrow(KubeError);
  });

  it("should scale with a merge patch of replicas on the StatefulSet itself", async () => {
    await kube().patchScale("va-1", 0);

    expect(seen[0]).toMatchObject({
      method: "PATCH",
      url: `/apis/apps/v1/namespaces/virtual-agents/statefulsets/va-1?fieldManager=${FIELD_MANAGER}`,
      body: JSON.stringify({ spec: { replicas: 0 } })
    });
    expect(seen[0]!.headers["content-type"]).toBe("application/merge-patch+json");
  });

  it("should give up on a request when the API does not answer in time", async () => {
    answer = () => {};

    await expect(kube(50).get("pods", "slow")).rejects.toThrow(/timed out/);
  });
});

describe("inClusterConfig", () => {
  it("should be undefined outside a cluster", () => {
    expect(inClusterConfig({})).toBeUndefined();
  });

  it("should read the namespace and CA from the ServiceAccount mount when it is in a cluster", () => {
    writeFileSync(join(dir, "namespace"), "virtual-agents\n");
    writeFileSync(join(dir, "ca.crt"), "CA");

    expect(inClusterConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1", KUBERNETES_SERVICE_PORT: "6443" }, dir)).toEqual({
      host: "10.0.0.1",
      port: 6443,
      namespace: "virtual-agents",
      tokenFile: join(dir, "token"),
      ca: Buffer.from("CA")
    });
  });

  it("should default to port 443 when no port is set", () => {
    writeFileSync(join(dir, "namespace"), "ns");
    writeFileSync(join(dir, "ca.crt"), "CA");

    expect(inClusterConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1" }, dir)?.port).toBe(443);
  });
});
