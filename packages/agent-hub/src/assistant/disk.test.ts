// What this pod tells the hub its volume holds. The hub's half, and the wording a person reads, is in
// dtsse-agent-hub's `src/assistant/upload-report.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UploadsReportBody } from "../api.ts";
import { attachmentPath } from "./attachments.ts";
import { type DiskFs, MAX_REPORTED_FILES, measureUploads, reportUploads, uploadIdOf } from "./disk.ts";

const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const OTHER_CONVERSATION = "99999999-8888-7777-6666-555555555555";
const UPLOAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_UPLOAD = "11112222-3333-4444-5555-666677778888";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-disk-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function write(root: string, conversation: string, uploadId: string, bytes: number, name = "letter.pdf"): void {
  const file = attachmentPath(root, conversation, uploadId, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
}

/**
 * A volume of `total` bytes with `used` of them taken, as `statfs` reports one. Cast through `unknown` because the
 * real `statfsSync` is overloaded on its `bigint` option, which a one-shape stub cannot satisfy.
 */
function withVolume(used: number, total: number, bsize = 4096): DiskFs {
  const statfsSync = () => ({ type: 0, bsize, blocks: total / bsize, bfree: (total - used) / bsize, bavail: (total - used) / bsize, files: 0, ffree: 0 });
  return { ...fs, statfsSync } as unknown as DiskFs;
}

describe("uploadIdOf", () => {
  it("should read the upload a written file is a copy of when it was named by the client", () => {
    expect(uploadIdOf(`${UPLOAD}-letter.pdf`)).toBe(UPLOAD);
  });

  it("should read an id written in capitals as the lower-case one the hub holds", () => {
    expect(uploadIdOf(`${UPLOAD.toUpperCase()}-letter.pdf`)).toBe(UPLOAD);
  });

  it.each([["letter.pdf"], [`${UPLOAD}.pdf`], ["not-an-id-letter.pdf"], [""]])("should name no upload for %s, which this client did not write", (name) => {
    expect(uploadIdOf(name)).toBeUndefined();
  });
});

describe("measureUploads", () => {
  it("should report the uploads' share and the whole volume when files are on it", () => {
    const root = tempRoot();
    write(root, CONVERSATION, UPLOAD, 8192);
    write(root, OTHER_CONVERSATION, OTHER_UPLOAD, 4096);

    expect(measureUploads({ root, fs: withVolume(30 * 1024 ** 3, 32 * 1024 ** 3) })).toEqual({
      uploads_bytes: 12288,
      volume_used_bytes: 30 * 1024 ** 3,
      volume_total_bytes: 32 * 1024 ** 3,
      files_total: 2,
      files: [
        { upload_id: UPLOAD, bytes: 8192 },
        { upload_id: OTHER_UPLOAD, bytes: 4096 }
      ],
      // A measurement acknowledges nothing; `reportUploads` is given whatever a deletion confirmed.
      deleted: []
    });
  });

  // Largest first, so a report that has to be cut names the files worth deleting.
  it("should list the largest files first when it reports them", () => {
    const root = tempRoot();
    write(root, CONVERSATION, UPLOAD, 4096);
    write(root, CONVERSATION, OTHER_UPLOAD, 8192);

    expect(measureUploads({ root, fs: withVolume(0, 1024 ** 3) })?.files.map((file) => file.bytes)).toEqual([8192, 4096]);
  });

  it("should report an empty uploads directory as no files rather than as nothing at all", () => {
    expect(measureUploads({ root: tempRoot(), fs: withVolume(1024, 1024 ** 3) })).toMatchObject({ uploads_bytes: 0, files: [] });
  });

  it("should still report the volume when the uploads directory does not exist yet", () => {
    const root = path.join(tempRoot(), "not-there");

    expect(measureUploads({ root, fs: withVolume(1024, 1024 ** 3) })).toMatchObject({ uploads_bytes: 0, volume_total_bytes: 1024 ** 3, files: [] });
  });

  // Bytes on the volume count whatever they are called; what the hub cannot do is name a file it has no row for.
  it("should count a file this client did not name towards the total, and leave it off the list", () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, CONVERSATION), { recursive: true });
    fs.writeFileSync(path.join(root, CONVERSATION, "stray.txt"), Buffer.alloc(512));

    expect(measureUploads({ root, fs: withVolume(0, 1024 ** 3) })).toMatchObject({ uploads_bytes: 512, files: [] });
  });

  // The cap is on what it names, not on what it counts: the hub needs the total to say a list was cut only when it
  // was, and the byte figures are of everything either way.
  it("should name only as many files as one report carries, and still count them all, when the pod holds more", () => {
    const root = tempRoot();
    for (let index = 0; index < MAX_REPORTED_FILES + 3; index += 1) {
      write(root, CONVERSATION, `aaaaaaaa-bbbb-cccc-dddd-${String(index).padStart(12, "0")}`, index + 1);
    }

    const report = measureUploads({ root, fs: withVolume(0, 1024 ** 3) });

    expect(report?.files).toHaveLength(MAX_REPORTED_FILES);
    expect(report?.files_total).toBe(MAX_REPORTED_FILES + 3);
  });

  // A volume of zero shown as fact would have the hub report a full disk as empty, with nothing saying it was a
  // guess. Reporting nothing leaves the hub saying it has not heard, which is true.
  it("should report nothing, and say why, when the volume cannot be measured", () => {
    const said: string[] = [];
    const broken = {
      ...fs,
      statfsSync: () => {
        throw new Error("no such volume");
      }
    } as unknown as DiskFs;

    expect(measureUploads({ root: tempRoot(), fs: broken, say: (m) => said.push(m) })).toBeUndefined();
    expect(said.join("\n")).toContain("no such volume");
  });

  it("should skip anything in the uploads root that is not a directory it wrote", () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, "a-stray-file"), "x");
    write(root, CONVERSATION, UPLOAD, 64);

    expect(measureUploads({ root, fs: withVolume(0, 1024 ** 3) })).toMatchObject({ uploads_bytes: 64 });
  });
});

describe("reportUploads", () => {
  it("should send what it measured to the hub when it can measure the volume", async () => {
    const root = tempRoot();
    write(root, CONVERSATION, UPLOAD, 2048);
    const sent: [string, UploadsReportBody][] = [];
    const api = {
      putUploads: async (id: string, body: UploadsReportBody) => {
        sent.push([id, body]);
        return null;
      }
    };

    const report = await reportUploads({ api, id: "va-1", root, fs: withVolume(1024, 4096) });

    expect(sent).toEqual([["va-1", report]]);
    expect(report).toMatchObject({ uploads_bytes: 2048, volume_used_bytes: 1024, volume_total_bytes: 4096, deleted: [] });
  });

  // The hub clears a deletion request on this and nothing else, so it has to be what the pod was given rather than
  // anything inferred from the files it happens to be naming.
  it("should carry the deletions it was given, beside the measurement, when it reports", async () => {
    const sent: UploadsReportBody[] = [];
    const api = {
      putUploads: async (_id: string, body: UploadsReportBody) => {
        sent.push(body);
        return null;
      }
    };

    await reportUploads({ api, id: "va-1", root: tempRoot(), fs: withVolume(0, 4096), deleted: [UPLOAD, OTHER_UPLOAD] });

    expect(sent[0]?.deleted).toEqual([UPLOAD, OTHER_UPLOAD]);
    expect(sent[0]?.files).toEqual([]);
  });

  it("should send nothing when there was nothing it could measure", async () => {
    const putUploads = vi.fn(async () => null);
    const broken = {
      ...fs,
      statfsSync: () => {
        throw new Error("no such volume");
      }
    } as unknown as DiskFs;

    expect(await reportUploads({ api: { putUploads }, id: "va-1", root: tempRoot(), fs: broken })).toBeUndefined();
    expect(putUploads).not.toHaveBeenCalled();
  });

  // Not retried here: the next reconcile measures again, and figures ten minutes old are better than a retry of a
  // measurement that is by then stale. The hub's wording is what keeps it honest, since it always says when.
  it("should say so and carry on, rather than throw, when the hub refuses the report", async () => {
    const said: string[] = [];
    const api = {
      putUploads: async () => {
        throw new Error("503 from the hub");
      }
    };

    expect(await reportUploads({ api, id: "va-1", root: tempRoot(), fs: withVolume(0, 4096), say: (m) => said.push(m) })).toBeUndefined();
    expect(said.join("\n")).toContain("503 from the hub");
  });
});
