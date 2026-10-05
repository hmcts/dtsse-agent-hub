import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealth, healthServer } from "./health.ts";
import type { Lease } from "./hub.ts";

describe("createHealth", () => {
  it("should be alive from startup until three intervals pass without a successful pass", () => {
    let now = 0;
    const health = createHealth(10_000, () => now);

    now = 30_000;
    expect(health.alive()).toBe(true);
    now = 30_001;
    expect(health.alive()).toBe(false);
  });

  it("should be alive again when a pass succeeds", () => {
    let now = 0;
    const health = createHealth(10_000, () => now);
    now = 100_000;

    health.passed();

    expect(health.alive()).toBe(true);
  });

  it("should stay alive on standby and name the holder until an active pass clears it", () => {
    let now = 0;
    const health = createHealth(10_000, () => now);
    const lease = { cluster: "cft-preview-01", renewed_at: "2026-10-05T12:00:00.000Z" };

    expect(health.standby()).toBeNull();
    now = 100_000;
    health.passed(lease);
    expect(health.alive()).toBe(true);
    expect(health.standby()).toEqual(lease);

    health.passed();
    expect(health.standby()).toBeNull();
  });

  it("should read the system clock when none is given", () => {
    expect(createHealth(10_000).alive()).toBe(true);
  });
});

describe("healthServer", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve(alive: boolean, standby: Lease | null = null): Promise<string> {
    const server = healthServer({ passed: () => {}, alive: () => alive, standby: () => standby });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each(["/health", "/health/liveness", "/health/readiness?x=1"])("should answer 200 UP on %s when alive", async (path) => {
    const response = await fetch(`${await serve(true)}${path}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP" });
  });

  it.each(["/health", "/health/liveness", "/health/readiness"])("should answer 200 UP on %s naming the lease holder when on standby", async (path) => {
    const response = await fetch(`${await serve(true, { cluster: "cft-preview-01", renewed_at: "2026-10-05T12:00:00.000Z" })}${path}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP", standby: true, lease_holder: "cft-preview-01" });
  });

  it("should answer 503 DOWN when on standby but no pass has succeeded for three intervals", async () => {
    const response = await fetch(`${await serve(false, { cluster: "cft-preview-01", renewed_at: "2026-10-05T12:00:00.000Z" })}/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "DOWN" });
  });

  it("should answer 503 DOWN when not alive", async () => {
    const response = await fetch(`${await serve(false)}/health`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "DOWN" });
  });

  it.each([
    ["another path", "GET", "/metrics"],
    ["another method", "POST", "/health"]
  ])("should answer 404 for %s", async (_label, method, path) => {
    expect((await fetch(`${await serve(true)}${path}`, { method })).status).toBe(404);
  });
});
