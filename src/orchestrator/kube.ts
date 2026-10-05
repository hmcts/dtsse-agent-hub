import { readFileSync } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";

/**
 * Just enough of the Kubernetes API for the orchestrator, over `node:https` with the pod's own ServiceAccount, so the
 * image carries no Kubernetes client library. Every call is in the one namespace the orchestrator runs in.
 */

export const FIELD_MANAGER = "agent-hub-orchestrator";

export const SERVICE_ACCOUNT_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

export interface ObjectMeta {
  name: string;
  namespace?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  creationTimestamp?: string;
  deletionTimestamp?: string;
}

export interface Resource {
  apiVersion: string;
  kind: string;
  metadata: ObjectMeta;
}

export interface StatefulSet extends Resource {
  spec?: { replicas?: number; [field: string]: unknown };
  status?: { replicas?: number; readyReplicas?: number };
}

export interface ContainerState {
  waiting?: { reason?: string; message?: string };
  running?: { startedAt?: string };
  terminated?: { reason?: string; exitCode?: number };
}

export interface ContainerStatus {
  name: string;
  ready?: boolean;
  state?: ContainerState;
  lastState?: ContainerState;
}

export interface PodCondition {
  type: string;
  status: string;
  reason?: string;
  lastTransitionTime?: string;
}

export interface Pod extends Resource {
  status?: { phase?: string; reason?: string; conditions?: PodCondition[]; containerStatuses?: ContainerStatus[] };
}

export interface Service extends Resource {
  spec?: { [field: string]: unknown };
}

export interface Ingress extends Resource {
  spec?: { [field: string]: unknown };
}

export interface Kinds {
  statefulsets: StatefulSet;
  pods: Pod;
  services: Service;
  ingresses: Ingress;
}

export type Kind = keyof Kinds;

const API: Record<Kind, string> = {
  statefulsets: "/apis/apps/v1",
  pods: "/api/v1",
  services: "/api/v1",
  ingresses: "/apis/networking.k8s.io/v1"
};

export interface Kube {
  get<K extends Kind>(kind: K, name: string): Promise<Kinds[K] | null>;
  list<K extends Kind>(kind: K, labelSelector: string): Promise<Kinds[K][]>;
  /** Server-side apply, taking every field this manager sets even if another manager set it last. */
  apply<K extends Kind>(kind: K, body: Kinds[K]): Promise<Kinds[K]>;
  /** `false` when there was nothing to delete. */
  delete(kind: Kind, name: string): Promise<boolean>;
  /** A merge patch of `spec.replicas` on the StatefulSet itself, so it needs no RBAC on the `scale` subresource. */
  patchScale(name: string, replicas: number): Promise<void>;
}

export class KubeError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

type Requester = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface KubeConfig {
  host: string;
  port: number;
  namespace: string;
  tokenFile: string;
  /** `undefined` where the transport is not TLS, as in tests. */
  ca?: Buffer;
  request?: Requester;
  timeoutMs?: number;
}

/** The connection a pod's mounted ServiceAccount gives it; `undefined` outside a cluster. */
export function inClusterConfig(env: Readonly<Record<string, string | undefined>> = process.env, dir: string = SERVICE_ACCOUNT_DIR): KubeConfig | undefined {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) {
    return undefined;
  }
  return {
    host,
    port: Number(env.KUBERNETES_SERVICE_PORT ?? "443"),
    namespace: readFileSync(`${dir}/namespace`, "utf8").trim(),
    tokenFile: `${dir}/token`,
    ca: readFileSync(`${dir}/ca.crt`)
  };
}

interface Reply {
  status: number;
  body: string;
}

function messageOf(reply: Reply): string {
  try {
    const parsed = JSON.parse(reply.body) as { message?: unknown };
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {}
  return reply.body.slice(0, 200);
}

export function createKube(config: KubeConfig): Kube {
  const send = config.request ?? (httpsRequest as Requester);
  const ns = encodeURIComponent(config.namespace);
  const collection = (kind: Kind) => `${API[kind]}/namespaces/${ns}/${kind}`;
  const item = (kind: Kind, name: string) => `${collection(kind)}/${encodeURIComponent(name)}`;

  function call(method: string, path: string, body?: unknown, contentType?: string): Promise<Reply> {
    // Read every call: the projected token is rotated on disk and the old one stops working.
    const token = readFileSync(config.tokenFile, "utf8").trim();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = send(
        {
          host: config.host,
          port: config.port,
          path,
          method,
          ca: config.ca,
          timeout: config.timeoutMs ?? 30_000,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(payload === undefined ? {} : { "content-type": contentType ?? "application/json", "content-length": Buffer.byteLength(payload) })
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          response.on("error", reject);
        }
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error(`${method} ${path} timed out`)));
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  }

  async function expectOk(method: string, path: string, body?: unknown, contentType?: string): Promise<string> {
    const reply = await call(method, path, body, contentType);
    if (reply.status < 200 || reply.status >= 300) {
      throw new KubeError(`${method} ${path}: ${reply.status} ${messageOf(reply)}`, reply.status);
    }
    return reply.body;
  }

  return {
    async get(kind, name) {
      const path = item(kind, name);
      const reply = await call("GET", path);
      if (reply.status === 404) {
        return null;
      }
      if (reply.status !== 200) {
        throw new KubeError(`GET ${path}: ${reply.status} ${messageOf(reply)}`, reply.status);
      }
      return JSON.parse(reply.body);
    },

    async list(kind, labelSelector) {
      const body = await expectOk("GET", `${collection(kind)}?labelSelector=${encodeURIComponent(labelSelector)}`);
      return (JSON.parse(body) as { items?: Kinds[typeof kind][] }).items ?? [];
    },

    async apply(kind, resource) {
      const query = `fieldManager=${FIELD_MANAGER}&force=true`;
      return JSON.parse(await expectOk("PATCH", `${item(kind, resource.metadata.name)}?${query}`, resource, "application/apply-patch+yaml"));
    },

    async delete(kind, name) {
      const path = item(kind, name);
      const reply = await call("DELETE", path, { kind: "DeleteOptions", apiVersion: "v1", propagationPolicy: "Background" });
      if (reply.status === 404) {
        return false;
      }
      if (reply.status < 200 || reply.status >= 300) {
        throw new KubeError(`DELETE ${path}: ${reply.status} ${messageOf(reply)}`, reply.status);
      }
      return true;
    },

    async patchScale(name, replicas) {
      await expectOk("PATCH", `${item("statefulsets", name)}?fieldManager=${FIELD_MANAGER}`, { spec: { replicas } }, "application/merge-patch+json");
    }
  };
}
