import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealth, healthServer } from "./health.ts";

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

  async function serve(alive: boolean): Promise<string> {
    const server = healthServer({ passed: () => {}, alive: () => alive });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it.each(["/health", "/health/liveness", "/health/readiness?x=1"])("should answer 200 UP on %s when alive", async (path) => {
    const response = await fetch(`${await serve(true)}${path}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "UP" });
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
