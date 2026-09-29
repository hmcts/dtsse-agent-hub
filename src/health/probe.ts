import type { HealthCheck, HealthStatus } from "@hmcts-cft/cloud-native-platform";

export interface ProbeResult {
  status: HealthStatus;
  services: Record<string, HealthStatus>;
}

export const LIVENESS_CHECKS: Record<string, HealthCheck> = {};

/**
 * No database query. A probe answers whether this process is serving HTTP; a `SELECT 1` through the shared pool
 * measures how busy the pool is, and in dtsse-github-metrics that took pods out of the Service under load while
 * they were healthy. A database diagnostic would need its own connection and an endpoint no probe polls.
 */
export const READINESS_CHECKS: Record<string, HealthCheck> = {};

export async function probe(checks: Record<string, HealthCheck>): Promise<ProbeResult> {
  const services: Record<string, HealthStatus> = {};
  let allUp = true;

  await Promise.all(
    Object.entries(checks).map(async ([name, check]) => {
      try {
        services[name] = await check();
      } catch {
        services[name] = "DOWN";
      }
      if (services[name] === "DOWN") {
        allUp = false;
      }
    })
  );

  return { status: allUp ? "UP" : "DOWN", services };
}

export async function probeResponse(checks: Record<string, HealthCheck>): Promise<Response> {
  const result = await probe(checks);
  return Response.json(result, { status: result.status === "UP" ? 200 : 503 });
}
