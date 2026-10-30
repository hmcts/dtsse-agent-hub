// Welsh translation jobs end to end through Postgres: the page's request, the frame the pod is sent, the pod's
// answer and files, and who may read any of it. The pod's own half — running the welsh plugin's scripts/welsh — is in the client
// package's `src/assistant/welsh.test.ts`.
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as downloadRoute from "../../src/app/api/ui/assistant/welsh/files/[fileId]/route.ts";
import * as uploadRoute from "../../src/app/api/ui/assistant/welsh/files/route.ts";
import * as welshRoute from "../../src/app/api/ui/assistant/welsh/route.ts";
import { WELSH_JOB_TIMEOUT_MS, WELSH_RATE_LIMIT, WELSH_RETENTION_MS } from "../../src/assistant/welsh.ts";
import { answerWelsh, askWelsh, ownerFile, pendingWelsh, podFile, putJobFile, readWelsh, saveUpload } from "../../src/assistant/welsh-store.ts";
import { setDesired } from "../../src/virtual-agents/store.ts";
import { ALICE, type AssistantFixture, BOB, podFixture } from "./assistant-pod.ts";
import { connect, prisma, resetDatabase } from "./database.ts";
import { jsonOf } from "./routes.ts";

vi.mock("next/headers", async () => (await import("./web-session.ts")).nextHeadersMock());
vi.mock("next/cache", async () => (await import("./web-session.ts")).nextCacheMock());

const client = await connect();
afterAll(async () => {
  await client.end();
});
beforeEach(async () => {
  await resetDatabase();
  vi.stubEnv("VIRTUAL_AGENTS_ENABLED", "true");
});

/** The shared fixture, bound to the claim this suite is about: the pod's own session runs Welsh jobs. */
const claimingWelsh = podFixture(["welsh"]);

/** That assistant with the Welsh plugin ticked as well, which every job and upload needs. */
const assistantOf: AssistantFixture = async (...args) => {
  const id = await claimingWelsh(...args);
  await prisma.virtualAgent.update({ where: { id }, data: { plugins: ["welsh"] } });
  return id;
};
const XLSX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

function browser(
  handler: (request: NextRequest) => Promise<Response>,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> },
  persona = "alice"
) {
  return handler(
    new NextRequest(`http://localhost:3000${path}`, { method: "POST", headers: { cookie: `ah_dev_persona=${persona}`, ...init.headers }, body: init.body })
  );
}

function start(body: unknown, persona = "alice") {
  return browser(welshRoute.POST, "/api/ui/assistant/welsh", { body: JSON.stringify(body), headers: { "content-type": "application/json" } }, persona);
}

describe("welsh jobs", () => {
  it("should record a long job, frame it for the pod, keep its answer and files, and give them back only to its owner", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };

    // Act
    const started = await jsonOf<{ status: string; job_id: string }>(await start({ kind: "scan", product: "cath", args: { repo: "apps/cath/cath-service" } }));
    const frame = await pendingWelsh(prisma, assistant, started.job_id);
    const fileId = await putJobFile(prisma, va, started.job_id, "cath-welsh-request.xlsx", XLSX);
    await answerWelsh(prisma, va, started.job_id, { result: { summary: { toWlu: 3 }, message: "3 new" } });
    // A second answer changes nothing.
    await answerWelsh(prisma, va, started.job_id, { error: "failed", detail: "late" });

    // Assert
    expect(started.status).toBe("pending");
    expect(frame).toEqual({ job_id: started.job_id, kind: "scan", product: "cath", args: { repo: "apps/cath/cath-service" } });
    expect(await readWelsh(prisma, ALICE.oid, started.job_id)).toEqual({
      status: "done",
      kind: "scan",
      result: { summary: { toWlu: 3 }, message: "3 new" },
      files: [{ file_id: fileId, name: "cath-welsh-request.xlsx", bytes: XLSX.length }]
    });
    expect(await readWelsh(prisma, BOB.oid, started.job_id)).toBeUndefined();
    expect(await pendingWelsh(prisma, assistant, started.job_id)).toBeUndefined();
    await expect(putJobFile(prisma, va, started.job_id, "late.xlsx", XLSX)).rejects.toMatchObject({ status: 404 });
    expect(Array.from((await ownerFile(prisma, ALICE.oid, fileId))?.bytes ?? [])).toEqual(Array.from(XLSX));
    expect(await ownerFile(prisma, BOB.oid, fileId)).toBeUndefined();
    // A file a job made is for its owner to download, never for the pod to read back as input.
    expect(await podFile(prisma, va, fileId)).toBeUndefined();
  });

  it("should upload a return, refuse what is not an xlsx, name it in the frame, and let only the owner's pod read it", async () => {
    // Arrange
    const assistant = await assistantOf(ALICE);
    await assistantOf(BOB);
    const bobs = await prisma.virtualAgent.findFirstOrThrow({ where: { ownerOid: BOB.oid }, select: { id: true } });

    // Act
    const refused = await browser(uploadRoute.POST, "/api/ui/assistant/welsh/files", { body: "English,Welsh", headers: { "x-file-name": "r.xlsx" } });
    const uploaded = await jsonOf<{ file_id: string }>(
      await browser(uploadRoute.POST, "/api/ui/assistant/welsh/files", { body: XLSX, headers: { "x-file-name": encodeURIComponent("Ymateb ŵ.xlsx") } })
    );
    const started = await jsonOf<{ job_id: string }>(await start({ kind: "import", product: "cath", args: { file_id: uploaded.file_id } }));
    const bobTries = await start({ kind: "import", product: "cath", args: { file_id: uploaded.file_id } }, "bob");
    const download = await downloadRoute.GET(
      new NextRequest(`http://localhost:3000/api/ui/assistant/welsh/files/${uploaded.file_id}`, { headers: { cookie: "ah_dev_persona=alice" } }),
      {
        params: Promise.resolve({ fileId: uploaded.file_id })
      }
    );

    // Assert
    expect(refused.status).toBe(400);
    expect((await pendingWelsh(prisma, assistant, started.job_id))?.file_name).toBe("Ymateb ŵ.xlsx");
    expect(bobTries.status).toBe(404);
    expect(await podFile(prisma, { id: assistant, ownerOid: ALICE.oid }, uploaded.file_id)).toMatchObject({ name: "Ymateb ŵ.xlsx" });
    expect(await podFile(prisma, { id: bobs.id, ownerOid: BOB.oid }, uploaded.file_id)).toBeUndefined();
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="Ymateb _.xlsx"; filename*=UTF-8''${encodeURIComponent("Ymateb ŵ.xlsx")}`);
    expect(download.headers.get("cache-control")).toBe("no-store");
  });

  it("should refuse a job and an upload, recording neither, when the person's assistant does not have the Welsh plugin", async () => {
    // Arrange
    await claimingWelsh(ALICE);

    // Act
    const job = await start({ kind: "info", product: "cath", args: {} });
    const uploaded = await browser(uploadRoute.POST, "/api/ui/assistant/welsh/files", { body: XLSX, headers: { "x-file-name": "return.xlsx" } });

    // Assert
    expect(job.status).toBe(409);
    expect(await jsonOf(job)).toEqual({ error: "turn on Welsh translations in Settings, under Tools, first" });
    expect(uploaded.status).toBe(409);
    expect(await prisma.assistantWelshJob.count()).toBe(0);
    expect(await prisma.assistantWelshFile.count()).toBe(0);
  });

  it("should answer a pod that has not claimed welsh, a stopped assistant, and a bad request without recording a job", async () => {
    const old = await assistantOf(ALICE, ["lookups"]);
    expect(await jsonOf(await start({ kind: "info", product: "cath", args: {} }))).toEqual({ status: "unsupported" });

    await setDesired(prisma, ALICE.oid, old, "stopped");
    expect(await jsonOf(await start({ kind: "info", product: "cath", args: {} }))).toEqual({ status: "waking" });

    expect((await start({ kind: "translate", product: "cath", args: {} })).status).toBe(400);
    expect((await start({ kind: "info", product: "general", args: {} })).status).toBe(400);
    expect((await start({ kind: "scan", product: "cath", args: { repo: "apps/pcs/pcs-frontend" } })).status).toBe(400);
    expect(await prisma.assistantWelshJob.count()).toBe(0);
  });

  it("should keep a failure in the pod's words, refuse a result too large to keep, and time out a job left unanswered", async () => {
    const assistant = await assistantOf(ALICE);
    const va = { id: assistant, ownerOid: ALICE.oid };
    const ask = () => askWelsh(prisma, { viewerOid: ALICE.oid, kind: "apply", product: "cath", args: {} });
    const jobOf = async () => {
      const asked = await ask();
      return "jobId" in asked ? asked.jobId : "";
    };

    const signedOut = await jobOf();
    await answerWelsh(prisma, va, signedOut, { error: "signed_out", detail: "Sign in to GitHub again." });
    expect(await readWelsh(prisma, ALICE.oid, signedOut)).toEqual({ status: "signed_out", detail: "Sign in to GitHub again." });

    const huge = await jobOf();
    await answerWelsh(prisma, va, huge, { result: { diff: "x".repeat(600 * 1024) } });
    expect(await readWelsh(prisma, ALICE.oid, huge)).toMatchObject({ status: "failed" });

    const forgotten = await jobOf();
    expect(await readWelsh(prisma, ALICE.oid, forgotten, new Date(Date.now() + WELSH_JOB_TIMEOUT_MS + 1000))).toEqual({ status: "timeout" });
  });

  it("should refuse jobs past the rate limit, and sweep jobs and files older than a week", async () => {
    const assistant = await assistantOf(ALICE);
    const old = new Date(Date.now() - WELSH_RETENTION_MS - 1000);
    await prisma.assistantWelshJob.create({ data: { virtualAgentId: assistant, kind: "info", product: "cath", args: {}, createdAt: old } });
    await saveUpload(prisma, ALICE.oid, "old.xlsx", XLSX, old);
    await prisma.assistantWelshJob.createMany({
      data: Array.from({ length: WELSH_RATE_LIMIT - 1 }, () => ({ virtualAgentId: assistant, kind: "info", product: "cath", args: {} }))
    });

    await askWelsh(prisma, { viewerOid: ALICE.oid, kind: "info", product: "cath", args: {} });
    expect(await prisma.assistantWelshJob.count({ where: { createdAt: old } })).toBe(0);
    expect(await prisma.assistantWelshFile.count()).toBe(0);
    await expect(askWelsh(prisma, { viewerOid: ALICE.oid, kind: "info", product: "cath", args: {} })).rejects.toMatchObject({ status: 429 });
  });
});
