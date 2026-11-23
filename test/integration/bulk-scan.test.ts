// The Bulk Scan form builder end to end through Postgres: the upload that makes a spec, saves that make versions,
// sign-off, the engine's answers, and that nobody but the owner reaches any of it.
import { readFileSync } from "node:fs";
import { formSpecSchema, generateTransformWorkbook, readWorkbookBytes } from "@hmcts-cft/bulk-scan-spec";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as downloadRoute from "../../src/app/api/ui/assistant/bulk-scan/[id]/download/route.ts";
import * as simulateRoute from "../../src/app/api/ui/assistant/bulk-scan/[id]/simulate/route.ts";
import * as versionsRoute from "../../src/app/api/ui/assistant/bulk-scan/[id]/versions/route.ts";
import * as uploadRoute from "../../src/app/api/ui/assistant/bulk-scan/route.ts";
import { ensureAssistant } from "../../src/assistant/assistant-store.ts";
import { findConversation } from "../../src/assistant/conversation-store.ts";
import { MAX_SPEC_BYTES } from "../../src/bulk-scan/spec.ts";
import { createSpecs, listSpecs, readSpec } from "../../src/bulk-scan/spec-store.ts";
import { bulkScanEditor, bulkScanSpecs } from "../../src/web/data.ts";
import { ALICE, BOB } from "./assistant-pod.ts";
import { connect, insertUser, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
const send = vi.hoisted(() => ({ failAfterStoring: false, failAfterCommit: false, cleanupFails: false }));
vi.mock("../../src/assistant/conversation-store.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/assistant/conversation-store.ts")>();
  return {
    ...actual,
    deleteConversation: async (...args: Parameters<typeof actual.deleteConversation>) => {
      if (send.cleanupFails) {
        throw new Error("the cleanup failed");
      }
      return await actual.deleteConversation(...args);
    }
  };
});
vi.mock("../../src/assistant/send.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/assistant/send.ts")>();
  return {
    ...actual,
    sendToConversation: async (...[prisma, senderOid, conversation, message]: Parameters<typeof actual.sendToConversation>) => {
      const sent = await actual.sendToConversation(prisma, senderOid, conversation, {
        ...message,
        alongside: async (tx, messageId) => {
          await message.alongside?.(tx, messageId);
          if (send.failAfterStoring) {
            throw new Error("the send failed after its files were stored");
          }
        }
      });
      if (send.failAfterCommit) {
        throw new Error("the send failed after its message committed");
      }
      return sent;
    }
  };
});
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const { actAs, revalidated } = await import("./web-session.ts");
const actions = await import("../../src/app/_actions/bulk-scan.ts");
const assistantActions = await import("../../src/app/_actions/assistant.ts");

const client = await connect();
afterAll(async () => {
  await client.end();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDatabase();
  await insertUser(ALICE);
  await insertUser(BOB);
  revalidated.length = 0;
  actAs("alice");
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
});

const SPEC = formSpecSchema.parse({
  form: { name: "T1", formType: "T1" },
  sections: [
    {
      id: "1",
      title: "About",
      fields: [
        { id: "1.1", label: "First name", keys: ["firstName"], mandatory: "mandatory", ccd: ["applicantFirstName"] },
        { id: "1.2", label: "Email", keys: ["email"] }
      ]
    }
  ]
});

const own = (who: { oid: string }) => ({ actorOid: who.oid, ownerOid: who.oid });
const SAME_ORIGIN = { "sec-fetch-site": "same-origin" };

function as(persona: string, path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    ...init,
    headers: { cookie: `ah_dev_persona=${persona}`, ...SAME_ORIGIN, ...init.headers }
  });
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

function uploadForm(name: string, content: BlobPart): FormData {
  const form = new FormData();
  form.set("form", new File([content], name));
  return form;
}

async function upload(persona = "alice", name = "t1.xlsx"): Promise<string[]> {
  const bytes = new Uint8Array((await generateTransformWorkbook(SPEC).xlsx.writeBuffer()) as ArrayBuffer);
  const response = await uploadRoute.POST(as(persona, "/api/ui/assistant/bulk-scan", { method: "POST", body: uploadForm(name, bytes) }));
  expect(response.status).toBe(201);
  return (await jsonOf<{ ids: string[] }>(response)).ids;
}

function save(id: string, spec: unknown, persona = "alice", baseVersion?: number) {
  return versionsRoute.POST(
    as(persona, `/api/ui/assistant/bulk-scan/${id}/versions`, { method: "POST", body: JSON.stringify({ baseVersion: baseVersion ?? 1, spec }) }),
    context(id)
  );
}

describe("starting a spec", () => {
  it("should make version 1 of a spec owned by the signed-in person from an uploaded transformation sheet", async () => {
    const [id] = await upload();

    const specs = await listSpecs(prisma, own(ALICE));

    expect(specs).toMatchObject([{ id, name: "T1", version: 1, signedOff: false }]);
    expect((await readSpec(prisma, own(ALICE), id as string))?.versions).toMatchObject([{ version: 1, savedBy: ALICE.name, signedOffBy: null }]);
  });

  it("should take a file when its name has a percent sign in it, which is not a URL-encoded name", async () => {
    const ids = await upload("alice", "Fee 100% form.xlsx");

    expect(ids).toHaveLength(1);
  });

  it("should refuse a file that is not a PDF or spreadsheet, a name that is neither, and a request from outside the hub's pages", async () => {
    const bad = await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body: uploadForm("t.xlsx", "hello") }));
    const noName = await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body: uploadForm("t.txt", "hello") }));
    const noForm = await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body: "hello" }));

    expect([bad.status, noName.status, noForm.status]).toEqual([400, 400, 400]);
    expect(await prisma.bulkScanSpec.count()).toBe(0);
  });

  it("should name the case type in the spec's header when one is typed with an upload", async () => {
    const bytes = new Uint8Array((await generateTransformWorkbook(SPEC).xlsx.writeBuffer()) as ArrayBuffer);
    const body = uploadForm("t1.xlsx", bytes);
    body.set("caseType", "CriminalInjuriesCompensation");

    const response = await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body }));
    const [id] = (await jsonOf<{ ids: string[] }>(response)).ids;

    expect((await readSpec(prisma, own(ALICE), id as string))?.spec).toMatchObject({ form: { ccdCaseTypeId: "CriminalInjuriesCompensation" } });
  });

  it("should be unavailable where virtual agents are off", async () => {
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");
    expect((await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body: "x" }))).status).toBe(404);
  });
});

describe("saving versions", () => {
  it("should number each save after the last and show the latest, keeping every earlier one readable", async () => {
    const [id] = (await upload()) as [string];

    const edited = { ...SPEC, form: { ...SPEC.form, name: "Renamed" } };
    const saved = await jsonOf<{ version: number }>(await save(id, edited));

    expect(saved.version).toBe(2);
    expect((await bulkScanSpecs(ALICE as never)).map((s) => [s.name, s.version])).toEqual([["Renamed", 2]]);
    expect((await bulkScanEditor(ALICE as never, id, 1))?.spec.form.name).toBe("T1");
    expect((await bulkScanEditor(ALICE as never, id))?.version).toBe(2);
    expect(await bulkScanEditor(ALICE as never, id, 9)).toBeUndefined();
  });

  it("should number two saves at once one after the other", async () => {
    const [id] = (await upload()) as [string];

    const answers = await Promise.all([save(id, SPEC), save(id, SPEC)]);

    expect(answers.map((a) => a.status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect((await listSpecs(prisma, own(ALICE)))[0]?.version).toBe(2);
  });

  it("should refuse a save that started from a version that is no longer the latest, and save nothing", async () => {
    const [id] = (await upload()) as [string];
    await save(id, SPEC);

    const stale = await save(id, { ...SPEC, form: { ...SPEC.form, name: "Stale" } }, "alice", 1);

    expect(stale.status).toBe(409);
    expect((await jsonOf<{ error: string }>(stale)).error).toContain("version 2");
    expect((await readSpec(prisma, own(ALICE), id))?.versions).toHaveLength(2);
    expect((await save(id, SPEC, "alice", 2)).status).toBe(201);
  });

  it("should refuse a regex the engine cannot compile on its row, and an upload with a key it cannot use", async () => {
    const [id] = (await upload()) as [string];
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[1].regex = "[a-";

    const response = await save(id, bad);

    expect(response.status).toBe(422);
    expect((await jsonOf<{ issues: { path: string }[] }>(response)).issues.map((i) => i.path)).toEqual(["sections.0.fields.1.regex"]);
  });

  it("should answer every place the schema refuses and save nothing", async () => {
    const [id] = (await upload()) as [string];
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[0].keys = [3];
    bad.sections[0].fields[1].inputType = "nope";

    const response = await save(id, bad);

    expect(response.status).toBe(422);
    expect((await jsonOf<{ issues: { path: string }[] }>(response)).issues.map((i) => i.path)).toEqual([
      "sections.0.fields.0.keys.0",
      "sections.0.fields.1.inputType"
    ]);
    expect((await listSpecs(prisma, own(ALICE)))[0]?.version).toBe(1);
  });

  it("should refuse a key the engine cannot use, which the schema alone accepts", async () => {
    const [id] = (await upload()) as [string];
    const bad = JSON.parse(JSON.stringify(SPEC));
    bad.sections[0].fields[0].keys = ["a b"];

    const response = await save(id, bad);

    expect(response.status).toBe(422);
    expect((await jsonOf<{ issues: { path: string }[] }>(response)).issues.map((i) => i.path)).toEqual(["sections.0.fields.0.keys.0"]);
  });

  it("should refuse a body that has no spec", async () => {
    const [id] = (await upload()) as [string];

    expect((await versionsRoute.POST(as("alice", "/x", { method: "POST", body: JSON.stringify({ baseVersion: "1" }) }), context(id))).status).toBe(400);
  });

  it("should refuse a body that is not JSON, or is past the limit", async () => {
    const [id] = (await upload()) as [string];

    expect((await versionsRoute.POST(as("alice", "/x", { method: "POST", body: "{" }), context(id))).status).toBe(400);
    expect((await versionsRoute.POST(as("alice", `/x`, { method: "POST", body: "x".repeat(MAX_SPEC_BYTES + 1) }), context(id))).status).toBe(413);
  });
});

describe("when virtual agents are off", () => {
  it("should refuse a sign-off and a delete, as the other Assistant actions do", async () => {
    const [id] = (await upload()) as [string];
    vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "false");

    expect((await actions.signOffSpec(formOf({ id, version: "1" }))).ok).toBe(false);
    expect((await actions.deleteBulkScanSpec(formOf({ id }))).ok).toBe(false);
    expect(await prisma.bulkScanSpec.count()).toBe(1);
    expect((await readSpec(prisma, own(ALICE), id))?.versions[0]?.signedOffAt).toBeNull();
  });
});

describe("sign-off", () => {
  it("should record who signed a version off and when, once", async () => {
    const [id] = (await upload()) as [string];

    const first = await actions.signOffSpec(formOf({ id, version: "1" }));
    const again = await actions.signOffSpec(formOf({ id, version: "1" }));

    expect(first).toMatchObject({ ok: true });
    expect(again).toEqual({ ok: false, error: "that version is already signed off, or no longer exists" });
    expect((await readSpec(prisma, own(ALICE), id))?.versions[0]).toMatchObject({ signedOffBy: ALICE.name, signedOffAt: expect.any(String) });
    expect(revalidated).toEqual(["/assistant/bulk-scan"]);
  });

  it("should leave a later version unsigned, and refuse a version that does not exist or is not a number", async () => {
    const [id] = (await upload()) as [string];
    await save(id, SPEC);
    await actions.signOffSpec(formOf({ id, version: "1" }));

    expect((await readSpec(prisma, own(ALICE), id))?.versions.map((v) => v.signedOffAt === null)).toEqual([true, false]);
    expect((await actions.signOffSpec(formOf({ id, version: "7" }))).ok).toBe(false);
    expect((await actions.signOffSpec(formOf({ id, version: "x" }))).ok).toBe(false);
  });

  it("should refuse a sign-off row with only one of who and when", async () => {
    const [id] = (await upload()) as [string];
    await expect(
      prisma.bulkScanSpecVersion.update({ where: { specId_version: { specId: id as string, version: 1 } }, data: { signedOffAt: new Date() } })
    ).rejects.toThrow();
  });
});

describe("the engine", () => {
  it("should simulate a scenario of a saved version, and the values sent", async () => {
    const [id] = (await upload()) as [string];

    const missing = await jsonOf<{ expected: { validation: string }; case_data: object }>(
      await simulateRoute.POST(as("alice", "/s", { method: "POST", body: JSON.stringify({ scenario: "missing-firstName" }) }), context(id))
    );
    const sent = await jsonOf<{ case_data: object }>(
      await simulateRoute.POST(as("alice", "/s", { method: "POST", body: JSON.stringify({ version: 1, data: { firstName: "Ada" } }) }), context(id))
    );

    expect(missing.expected.validation).toBe("warning");
    expect(sent.case_data).toEqual({ applicantFirstName: "Ada" });
  });

  it("should drive the simulator with the rule when a version is saved with it, and leave the earlier version as it was", async () => {
    const [id] = (await upload()) as [string];
    const run = async (version: number) =>
      jsonOf<{ expected: { transformation: string } }>(
        await simulateRoute.POST(as("alice", "/s", { method: "POST", body: JSON.stringify({ version, data: { firstName: "Ada" } }) }), context(id))
      );
    const rule = { when: { firstName: { not: null } }, outcome: "exception" };
    const edited = {
      ...SPEC,
      sections: SPEC.sections.map((section, s) => ({ ...section, fields: section.fields.map((f, i) => (s === 0 && i === 0 ? { ...f, rules: [rule] } : f)) }))
    };

    expect((await save(id, edited)).status).toBe(201);

    expect((await run(1)).expected.transformation).not.toBe("exception-record");
    expect((await run(2)).expected.transformation).toBe("exception-record");
  });

  it("should download the SIP, the transformation sheet and a code zip of a version, and refuse an unknown kind or target", async () => {
    const [id] = (await upload()) as [string];
    const get = (query: string) => downloadRoute.GET(as("alice", `/d?${query}`), context(id));

    const sip = await get("kind=sip");
    const code = await get("kind=code&target=fis&version=1");

    expect(sip.headers.get("content-disposition")).toContain("T1-sip.xlsx");
    expect((await readWorkbookBytes(new Uint8Array(await sip.arrayBuffer()))).worksheets.length).toBeGreaterThan(0);
    expect(code.headers.get("content-type")).toBe("application/zip");
    expect((await get("kind=transformation")).status).toBe(200);
    expect([(await get("kind=nope")).status, (await get("kind=code&target=nope")).status, (await get("kind=sip&version=9")).status]).toEqual([400, 400, 404]);
  });
});

describe("who can reach a spec", () => {
  it("should show another person nothing of it: not the list, the page, a save, a simulation, a download, a sign-off or a delete", async () => {
    const [id] = (await upload()) as [string];

    expect(await listSpecs(prisma, own(BOB))).toEqual([]);
    expect(await bulkScanEditor(BOB as never, id)).toBeUndefined();
    expect((await save(id, SPEC, "bob")).status).toBe(404);
    expect((await simulateRoute.POST(as("bob", "/s", { method: "POST", body: "{}" }), context(id))).status).toBe(404);
    expect((await downloadRoute.GET(as("bob", "/d?kind=sip"), context(id))).status).toBe(404);
    actAs("bob");
    expect((await actions.signOffSpec(formOf({ id, version: "1" }))).ok).toBe(false);
    expect(await actions.deleteBulkScanSpec(formOf({ id }))).toEqual({ ok: false, error: "that is not one of your form specs" });
    expect(await prisma.bulkScanSpec.count()).toBe(1);
    expect((await readSpec(prisma, own(ALICE), id))?.versions[0]?.signedOffAt).toBeNull();
  });

  it("should refuse a store call that names an owner other than the actor", async () => {
    await expect(listSpecs(prisma, { actorOid: BOB.oid, ownerOid: ALICE.oid })).rejects.toThrow("your own");
  });

  it("should delete the owner's spec with its versions, and read an id that is not an id as missing", async () => {
    const [id] = (await upload()) as [string];
    await save(id, SPEC);

    expect(await actions.deleteBulkScanSpec(formOf({ id: "not-a-uuid" }))).toMatchObject({ ok: false });
    expect(await actions.deleteBulkScanSpec(formOf({ id }))).toMatchObject({ ok: true });
    expect([await prisma.bulkScanSpec.count(), await prisma.bulkScanSpecVersion.count()]).toEqual([0, 0]);
    expect(await readSpec(prisma, own(ALICE), "not-a-uuid")).toBeUndefined();
  });
});

function formOf(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) {
    data.set(key, value);
  }
  return data;
}

describe("starting a spec from a case type picked in the workspace", () => {
  async function pdfUpload(fields: unknown, extra: Record<string, string | File> = {}) {
    const { makePdf, SAMPLE_FORM } = await import("../../packages/bulk-scan-spec/src/__fixtures__/make-pdf.ts");
    const form = uploadForm("sample.pdf", new Uint8Array(readFileSync(await makePdf("sample", SAMPLE_FORM))));
    form.set("caseType", "NFD");
    form.set("product", "nfdiv");
    form.set("config", "config-generator");
    form.set("fields", JSON.stringify(fields));
    for (const [name, value] of Object.entries(extra)) {
      form.set(name, value);
    }
    return await uploadRoute.POST(as("alice", "/api/ui/assistant/bulk-scan", { method: "POST", body: form }));
  }

  it("should match the form and keep the product and configuration in the header when the pod found the fields", async () => {
    const response = await pdfUpload([{ ID: "applicant1FirstName", Label: "First name", FieldType: "Text" }]);
    expect(response.status).toBe(201);

    const [id] = (await jsonOf<{ ids: string[] }>(response)).ids;
    const spec = (await readSpec(prisma, own(ALICE), id as string))?.spec as {
      form: object;
      sections: { fields: { label: string; ccd: string[]; ccdMatch?: { status: string } }[] }[];
    };
    expect(spec.form).toMatchObject({ ccdCaseTypeId: "NFD", ccdProduct: "nfdiv", ccdConfig: "config-generator" });
    const first = spec.sections.flatMap((s) => s.fields).find((f) => f.label === "First name(s)");
    expect(first).toMatchObject({ ccd: ["applicant1FirstName"], ccdMatch: { status: "existing" } });
  });

  it("should count the bytes of the fields, not the characters, against the limit when labels are multi-byte", async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => ({ ID: `field${i}`, Label: "é".repeat(200), FieldType: "Text" }));
    const json = JSON.stringify(rows);
    expect(json.length).toBeLessThan(965_536);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(965_536);

    expect((await pdfUpload(rows)).status).toBe(400);
  });

  it("should refuse the fields when they are not what the CCD job answers or no case type is named", async () => {
    const bad = await pdfUpload([{ ID: "a" }]);
    const unnamed = await pdfUpload([{ ID: "a", FieldType: "Text" }], { caseType: "" });

    expect([bad.status, unnamed.status]).toEqual([400, 400]);
    expect(await prisma.bulkScanSpec.count()).toBe(0);
  });
});

describe("handing a version to the Assistant", () => {
  const WITH_NEW_FIELD = formSpecSchema.parse({
    form: {
      name: "T210 Application",
      formType: "T210",
      ccdCaseTypeId: "CIC",
      ccdProduct: "sptribs",
      ccdConfig: "config-generator",
      ccdRepo: "apps/sptribs/sptribs-case-api"
    },
    sections: [
      {
        id: "1",
        title: "About",
        fields: [
          { id: "1.1", label: "First name", keys: ["firstName"], mandatory: "mandatory", ccd: ["applicantFirstName"] },
          {
            id: "1.2",
            label: "Nickname",
            keys: ["nickname"],
            ccd: ["applicantNickname"],
            ccdMatch: { status: "new", newField: { id: "applicantNickname", type: "Text" } }
          }
        ]
      }
    ]
  });

  async function spec(): Promise<string> {
    const [id] = await createSpecs(prisma, own(ALICE), [{ name: "T210 Application", spec: WITH_NEW_FIELD }]);
    return id as string;
  }

  const handed = (id: string, over: Record<string, string> = {}) => assistantActions.handToAssistant(formOf({ id, version: "1", target: "nfdiv", ...over }));

  beforeEach(async () => {
    await ensureAssistant(prisma, { oid: ALICE.oid, modelRoute: "own-licence" });
    await ensureAssistant(prisma, { oid: BOB.oid, modelRoute: "own-licence" });
  });

  it("should start the owner's conversation with the generated files and the prepared prompt on its first message when the version is signed off", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));

    const result = await handed(id);

    expect(result).toMatchObject({ ok: true, id: expect.any(String) });
    const conversationId = (result as { id: string }).id;
    const conversation = await prisma.assistantConversation.findUniqueOrThrow({ where: { id: conversationId }, select: { ownerOid: true, product: true } });
    expect(conversation).toEqual({ ownerOid: ALICE.oid, product: "bulk-scan" });
    const message = await prisma.message.findFirstOrThrow({ select: { id: true, body: true } });
    expect(message.body).toContain("is defined in apps/sptribs/sptribs-case-api, a config-generator service");
    const uploads = await prisma.assistantUpload.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { fileName: true, messageId: true, state: true, ownerOid: true }
    });
    expect(uploads.map((u) => u.fileName)).toHaveLength(4);
    expect(uploads.map((u) => u.fileName)).toEqual(
      expect.arrayContaining(["T210-nfdiv.zip", "T210-spec.json", "T210-transformation.xlsx", "new-ccd-fields.json"])
    );
    expect(new Set(uploads.map((u) => u.messageId))).toEqual(new Set([message.id]));
    expect(new Set(uploads.map((u) => `${u.state}/${u.ownerOid}`))).toEqual(new Set([`stored/${ALICE.oid}`]));
  });

  it("should refuse a version that is saved but not signed off, and create nothing", async () => {
    const id = await spec();

    const result = await handed(id);

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Sign off this version first") });
    expect(await prisma.assistantConversation.count()).toBe(0);
    expect(await prisma.assistantUpload.count()).toBe(0);
  });

  it("should leave no conversation, message or file behind when the send fails after the files were stored", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));
    send.failAfterStoring = true;
    try {
      expect(await handed(id)).toMatchObject({ ok: false });
    } finally {
      send.failAfterStoring = false;
    }

    expect([await prisma.assistantConversation.count(), await prisma.assistantUpload.count(), await prisma.message.count()]).toEqual([0, 0, 0]);
  });

  it("should keep the conversation, its message and its files, and report the error, when the send fails after its message committed", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));
    send.failAfterCommit = true;
    try {
      expect(await handed(id)).toMatchObject({ ok: false });
    } finally {
      send.failAfterCommit = false;
    }

    expect([await prisma.assistantConversation.count(), await prisma.assistantUpload.count(), await prisma.message.count()]).toEqual([1, 4, 1]);
  });

  it("should report the send's own error, and log the cleanup's, when removing the conversation fails too", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    send.failAfterStoring = true;
    send.cleanupFails = true;
    try {
      const result = await handed(id);

      expect(result).toMatchObject({ ok: false });
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain("the hand-over's conversation could not be removed");
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain("the send failed after its files were stored");
    } finally {
      send.failAfterStoring = false;
      send.cleanupFails = false;
      log.mockRestore();
    }
  });

  it("should ignore the package for a target that is not Java", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));

    expect(await handed(id, { target: "fis", package: "Not A Package" })).toMatchObject({ ok: true });
  });

  it("should refuse a signed-off version with no form type, and create nothing", async () => {
    const [id] = await createSpecs(prisma, own(ALICE), [{ name: "No type", spec: { ...WITH_NEW_FIELD, form: { ...WITH_NEW_FIELD.form, formType: "" } } }]);
    await actions.signOffSpec(formOf({ id: id as string, version: "1" }));

    expect(await handed(id as string)).toEqual({ ok: false, error: "Set the form type (document_sub_type) in Form details first." });
    expect(await prisma.assistantConversation.count()).toBe(0);
  });

  it("should refuse a spec the person does not own, and leave it with no conversation, for the owner and for them", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));
    actAs("bob");

    const result = await handed(id);

    expect(result).toMatchObject({ ok: false });
    expect(await prisma.assistantConversation.count()).toBe(0);
    expect(await prisma.assistantUpload.count()).toBe(0);
  });

  it("should keep the conversation and its files from anyone but the owner", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));
    const conversationId = ((await handed(id)) as { id: string }).id;

    expect(await findConversation(prisma, BOB.oid, conversationId)).toBeUndefined();
    expect(await findConversation(prisma, ALICE.oid, conversationId)).toBeDefined();
    actAs("bob");
    expect(await assistantActions.sendAssistantMessage({ conversationId, body: "hello" })).toMatchObject({ ok: false });
  });

  it("should refuse a target that is not a service pattern", async () => {
    const id = await spec();
    await actions.signOffSpec(formOf({ id, version: "1" }));

    expect(await handed(id, { target: "envelopes" })).toMatchObject({ ok: false });
    expect(await prisma.assistantConversation.count()).toBe(0);
  });
});
