import { describe, expect, it } from "vitest";
import type { Database } from "../store/prisma.ts";
import { attachmentView, type UploadRow, uploadBytes, uploadHeldUntil } from "./upload-store.ts";
import { UPLOAD_RETENTION_HOURS } from "./upload-sweep.ts";
import { PART_BYTES } from "./uploads.ts";

/**
 * The pure and near-pure half of the upload store: the retention window every chip and every refusal is decided
 * from, and the outbound stream's promise to hold one part at a time. The database is stood in for here so that
 * promise can be asserted as a count of rows read rather than as a memory reading — `test/integration/
 * assistant-uploads.test.ts` measures the memory, and a measurement can only ever be read against noise.
 */

const CREATED = new Date("2026-10-21T09:00:00.000Z");

function row(overrides: Partial<UploadRow> = {}): UploadRow {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    conversationId: "99999999-8888-7777-6666-555555555555",
    ownerOid: "oid-owner",
    messageId: "41",
    fileName: "my letter (final).pdf",
    storedName: "my_letter_final_.pdf",
    mediaType: "application/pdf",
    bytes: PART_BYTES * 3,
    state: "fetched",
    createdAt: CREATED,
    ...overrides
  };
}

/** A database that answers each part row with its own index, and counts how many it has been asked for. */
function parts(upload: UploadRow, missing: number = -1) {
  const read: number[] = [];
  const db = {
    assistantUploadPart: {
      findUnique: async ({ where }: { where: { uploadId_index: { uploadId: string; index: number } } }) => {
        const { index } = where.uploadId_index;
        read.push(index);
        if (index === missing) {
          return null;
        }
        const length = Math.min(PART_BYTES, upload.bytes - index * PART_BYTES);
        return { data: new Uint8Array(length).fill(index) };
      }
    }
  } as unknown as Database;
  return { db, read };
}

describe("uploadHeldUntil", () => {
  it("should close the window the retention hours after the upload was started", () => {
    expect(uploadHeldUntil(CREATED).toISOString()).toBe(new Date(CREATED.getTime() + UPLOAD_RETENTION_HOURS * 3_600_000).toISOString());
  });

  it("should measure from the upload rather than from the message, so a slow send does not extend it", () => {
    const earlier = new Date(CREATED.getTime() - 3_600_000);
    expect(uploadHeldUntil(earlier).getTime()).toBeLessThan(uploadHeldUntil(CREATED).getTime());
  });
});

describe("attachmentView", () => {
  const loaded = { id: "u1", fileName: "letter.pdf", bytes: 2048n, mediaType: "application/pdf", createdAt: CREATED };

  it.each([["stored"], ["fetched"]] as const)("should give the window when the upload is %s, since the bytes are there", (state) => {
    expect(attachmentView({ ...loaded, state })).toEqual({
      id: "u1",
      name: "letter.pdf",
      bytes: 2048,
      media_type: "application/pdf",
      available_until: uploadHeldUntil(CREATED).toISOString()
    });
  });

  it.each([["pending"], ["expired"]] as const)("should give no window when the upload is %s, so no chip offers a download", (state) => {
    expect(attachmentView({ ...loaded, state })).toMatchObject({ available_until: null });
  });
});

describe("uploadBytes", () => {
  it("should read one part row only, however much of the file the reader has still to take", async () => {
    // The outbound half of the rule the upload routes keep. A stream that read every row up front would answer the
    // same bytes and cost the whole file in memory to do it, and nothing about the bytes would say so.
    // Arrange
    const upload = row();
    const { db, read } = parts(upload);

    // Act
    const reader = uploadBytes(db, upload).getReader();
    const first = await reader.read();

    // Assert: the part handed over, and at most the one queued behind it.
    expect(first.value?.byteLength).toBe(PART_BYTES);
    expect(read.length).toBeLessThanOrEqual(2);
    await reader.cancel();
  });

  it("should answer every part in order, and close once the last one has gone", async () => {
    // Arrange
    const upload = row({ bytes: PART_BYTES * 2 + 100 });
    const { db, read } = parts(upload);

    // Act
    const chunks: Uint8Array[] = [];
    const reader = uploadBytes(db, upload).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
    }

    // Assert
    expect(read).toEqual([0, 1, 2]);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([PART_BYTES, PART_BYTES, 100]);
    expect(chunks.map((chunk) => chunk[0])).toEqual([0, 1, 2]);
  });

  it("should error rather than close short when a part row has gone, so no truncated file is kept", async () => {
    // A short file that looked complete is the one outcome worth refusing to produce: the person would save it and
    // never know. It should not happen — the window takes all of an upload's parts at once — but it must not pass.
    // Arrange
    const upload = row({ bytes: PART_BYTES * 2 });
    const { db } = parts(upload, 1);

    // Act
    const reader = uploadBytes(db, upload).getReader();
    await reader.read();

    // Assert
    await expect(reader.read()).rejects.toThrow("is no longer there");
  });
});
