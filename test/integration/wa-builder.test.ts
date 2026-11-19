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
    expect(await saveWaSpec({ service: "employment", model, ordering, layout, savedBy: "alice" })).toEqual({ version: 1 });

    const read = await getWaSpec("employment");

    expect(read).toMatchObject({ service: "employment", version: 1, savedBy: "alice" });
    expect(read?.model).toEqual(model);
    expect(read?.ordering).toEqual(ordering);
    expect(read?.layout).toEqual(layout);
  });

  it("should number versions per service and read the latest when none is named", async () => {
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });
    await saveWaSpec({ service: "employment", model, savedBy: "bob", basedOn: 1 });
    const other = { ...model, service: { ...model.service, slug: "civil", displayName: "Civil" } };
    await saveWaSpec({ service: "civil", model: other, savedBy: "alice" });

    expect((await getWaSpec("employment"))?.version).toBe(2);
    expect((await getWaSpec("employment", 1))?.savedBy).toBe("alice");
    expect((await getWaSpec("civil"))?.version).toBe(1);
    expect(await getWaSpec("employment", 3)).toBeNull();
    expect(await getWaSpec("nfd")).toBeNull();
  });

  it("should list each service once at its latest version when several are saved", async () => {
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });
    const other = { ...model, service: { ...model.service, slug: "civil", displayName: "Civil" } };
    await saveWaSpec({ service: "civil", model: other, savedBy: "alice" });

    const services = await listWaServices();

    expect(services.map(({ service, displayName, latestVersion }) => ({ service, displayName, latestVersion }))).toEqual([
      { service: "civil", displayName: "Civil", latestVersion: 1 },
      { service: "employment", displayName: "Employment", latestVersion: 2 }
    ]);
    expect(services[1]?.updatedAt).toBeInstanceOf(Date);
  });

  it("should refuse when the edit is based on a version that is not the latest", async () => {
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });
    await saveWaSpec({ service: "employment", model, savedBy: "alice", basedOn: 1 });

    await expect(saveWaSpec({ service: "employment", model, savedBy: "bob", basedOn: 1 })).rejects.toBeInstanceOf(WaVersionConflict);
    expect((await getWaSpec("employment"))?.version).toBe(2);
  });

  it("should save every one as its own version when saves race", async () => {
    const saves = await Promise.all([1, 2, 3, 4].map((n) => saveWaSpec({ service: "employment", model, savedBy: `person-${n}` })));

    expect(saves.map(({ version }) => version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("should let only one save through when two edits race from the same version", async () => {
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });

    const results = await Promise.allSettled([
      saveWaSpec({ service: "employment", model, savedBy: "alice", basedOn: 1 }),
      saveWaSpec({ service: "employment", model, savedBy: "bob", basedOn: 1 })
    ]);

    expect(results.map(({ status }) => status).sort((a, b) => a.localeCompare(b))).toEqual(["fulfilled", "rejected"]);
  });

  it("should refuse and store nothing when the model is for another service", async () => {
    await expect(saveWaSpec({ service: "civil", model, savedBy: "alice" })).rejects.toBeInstanceOf(InvalidWaSpec);
    expect(await listWaServices()).toEqual([]);
  });

  it("should refuse to change or delete a saved version", async () => {
    await saveWaSpec({ service: "employment", model, savedBy: "alice" });

    await expect(prisma.waSpecVersion.update({ where: { service_version: { service: "employment", version: 1 } }, data: { savedBy: "bob" } })).rejects.toThrow(
      /append-only/
    );
    await expect(prisma.waSpecVersion.deleteMany({ where: { service: "employment" } })).rejects.toThrow(/append-only/);
  });
});
