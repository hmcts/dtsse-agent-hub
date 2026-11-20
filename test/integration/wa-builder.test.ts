// WA spec versions through Postgres: numbering, optimistic refusal, concurrent saves, append-only rows, and ET's
// example reading back as it went in.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLayout, parseModel, parseOrdering } from "@hmcts-cft/wa-spec";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidWaSpec, WaVersionConflict } from "../../src/assistant/wa-builder.ts";
import { getWaSpec, listWaServices, saveWaSpec } from "../../src/assistant/wa-builder-store.ts";
import { prisma, resetDatabase } from "./database.ts";

const example = (name: string) => readFileSync(fileURLToPath(new URL(`../../packages/wa-spec/examples/et/${name}`, import.meta.url)), "utf8");
const model = parseModel(example("model.yaml"));
const ordering = parseOrdering(example("model.order.yaml"));
const layout = parseLayout(example("spec.layout.yaml"));

beforeEach(resetDatabase);

describe("wa specs", () => {
  it("should read back ET's model, ordering and layout unchanged when saved as version 1", async () => {
    expect(await saveWaSpec(prisma, { service: "employment", model, ordering, layout, savedBy: "alice", basedOn: 0 })).toEqual({ version: 1 });

    const read = await getWaSpec(prisma, "employment");

    expect(read).toMatchObject({ service: "employment", version: 1, savedBy: "alice" });
    const { order: _order, layout: _layout, ...withoutFiles } = model;
    expect(read?.model).toEqual(withoutFiles);
    expect(read?.ordering).toEqual(ordering);
    expect(read?.layout).toEqual(layout);
  });

  it("should number versions per service and read the latest when none is named", async () => {
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 0 });
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "bob", basedOn: 1 });
    const other = { ...model, service: { ...model.service, slug: "civil", displayName: "Civil" } };
    await saveWaSpec(prisma, { service: "civil", model: other, savedBy: "alice", basedOn: 0 });

    expect((await getWaSpec(prisma, "employment"))?.version).toBe(2);
    expect((await getWaSpec(prisma, "employment", 1))?.savedBy).toBe("alice");
    expect((await getWaSpec(prisma, "civil"))?.version).toBe(1);
    expect(await getWaSpec(prisma, "employment", 3)).toBeNull();
    expect(await getWaSpec(prisma, "nfd")).toBeNull();
  });

  it("should store a service whose slug has an underscore when it is saved", async () => {
    const other = { ...model, service: { ...model.service, slug: "st_cic" } };

    expect(await saveWaSpec(prisma, { service: "st_cic", model: other, savedBy: "alice", basedOn: 0 })).toEqual({ version: 1 });
  });

  it("should list each service once at its latest version when several are saved", async () => {
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 0 });
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 1 });
    const other = { ...model, service: { ...model.service, slug: "civil", displayName: "Civil" } };
    await saveWaSpec(prisma, { service: "civil", model: other, savedBy: "alice", basedOn: 0 });

    const services = await listWaServices(prisma);

    expect(services.map(({ service, displayName, latestVersion }) => ({ service, displayName, latestVersion }))).toEqual([
      { service: "civil", displayName: "Civil", latestVersion: 1 },
      { service: "employment", displayName: "Employment", latestVersion: 2 }
    ]);
    expect(services[1]?.updatedAt).toBeInstanceOf(Date);
  });

  it("should refuse when the edit is based on a version that is not the latest", async () => {
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 0 });
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 1 });

    await expect(saveWaSpec(prisma, { service: "employment", model, savedBy: "bob", basedOn: 1 })).rejects.toBeInstanceOf(WaVersionConflict);
    expect((await getWaSpec(prisma, "employment"))?.version).toBe(2);
  });

  it("should store one version and refuse the rest when four first saves race", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => saveWaSpec(prisma, { service: "employment", model, savedBy: `person-${n}`, basedOn: 0 })));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    for (const result of results.filter((r) => r.status === "rejected")) {
      expect(result.reason).toBeInstanceOf(WaVersionConflict);
    }
    expect((await getWaSpec(prisma, "employment"))?.version).toBe(1);
  });

  it("should let only one save through when two edits race from the same version", async () => {
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 0 });

    const results = await Promise.allSettled([
      saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 1 }),
      saveWaSpec(prisma, { service: "employment", model, savedBy: "bob", basedOn: 1 })
    ]);

    expect(results.map(({ status }) => status).sort((a, b) => a.localeCompare(b))).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "rejected")?.reason).toBeInstanceOf(WaVersionConflict);
  });

  it("should refuse and store nothing when the model is for another service", async () => {
    await expect(saveWaSpec(prisma, { service: "civil", model, savedBy: "alice", basedOn: 0 })).rejects.toBeInstanceOf(InvalidWaSpec);
    expect(await listWaServices(prisma)).toEqual([]);
  });

  it("should refuse to change or delete a saved version when the row is updated or deleted directly", async () => {
    await saveWaSpec(prisma, { service: "employment", model, savedBy: "alice", basedOn: 0 });

    await expect(prisma.waSpecVersion.update({ where: { service_version: { service: "employment", version: 1 } }, data: { savedBy: "bob" } })).rejects.toThrow(
      /append-only/
    );
    await expect(prisma.waSpecVersion.deleteMany({ where: { service: "employment" } })).rejects.toThrow(/append-only/);
  });
});
