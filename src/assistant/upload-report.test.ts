import { describe, expect, it } from "vitest";
import { describeSize, isDiskSize, MAX_REPORTED_FILES, readReportedFiles, type UploadsReportRow, uploadsDisk } from "./upload-report.ts";

const ID = "0f8a6a1e-0000-4000-8000-000000000001";
const OTHER = "0f8a6a1e-0000-4000-8000-000000000002";

function row(overrides: Partial<UploadsReportRow> = {}): UploadsReportRow {
  return {
    uploadsBytes: 2_254_857_830n,
    volumeUsedBytes: 30_477_004_800n,
    volumeTotalBytes: 34_359_738_368n,
    uploadsReportedAt: new Date("2026-10-29T09:00:00.000Z"),
    running: true,
    reports: true,
    ...overrides
  };
}

describe("describeSize", () => {
  it.each([
    [0, "0 bytes"],
    [1, "1 bytes"],
    [1023, "1,023 bytes"],
    [1024, "1 KB"],
    [831_488, "812 KB"],
    [4 * 1024 * 1024, "4 MB"],
    [2_254_857_830, "2.1 GB"],
    [34_359_738_368, "32 GB"],
    [2 * 1024 ** 4, "2 TB"]
  ])("should say %i bytes is %s when a person reads it", (bytes, expected) => {
    expect(describeSize(bytes)).toBe(expected);
  });

  // A negative figure can only be a bug, and "-1 bytes" in a settings page is worse than a floor at nothing.
  it("should say nothing rather than a negative size when the figure is below zero", () => {
    expect(describeSize(-5)).toBe("0 bytes");
  });
});

describe("isDiskSize", () => {
  it.each([[0], [1], [34_359_738_368]])("should accept %i as a disk figure when it is a whole count of bytes", (value) => {
    expect(isDiskSize(value)).toBe(true);
  });

  it.each([
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
    ["1"],
    [null],
    [undefined]
  ] as const)("should refuse %s as a disk figure when it is not a whole count of bytes", (value) => {
    expect(isDiskSize(value)).toBe(false);
  });
});

describe("readReportedFiles", () => {
  it("should keep the entries it can read, in the order the pod sent them, when a report arrives", () => {
    expect(
      readReportedFiles([
        { upload_id: ID, bytes: 4 },
        { upload_id: OTHER, bytes: 0 }
      ])
    ).toEqual([
      { upload_id: ID, bytes: 4 },
      { upload_id: OTHER, bytes: 0 }
    ]);
  });

  it("should lower-case an id so it matches the hub's own rows when a pod reports it in capitals", () => {
    expect(readReportedFiles([{ upload_id: ID.toUpperCase(), bytes: 4 }])).toEqual([{ upload_id: ID, bytes: 4 }]);
  });

  // Dropped rather than refused: the whole report would otherwise be lost over one file, and the totals beside it —
  // which are what the person is actually told — do not depend on the list at all.
  it.each([
    ["an id that is not a uuid", { upload_id: "not-a-uuid", bytes: 4 }],
    ["no id", { bytes: 4 }],
    ["a size that is not a whole number", { upload_id: ID, bytes: 1.5 }],
    ["a negative size", { upload_id: ID, bytes: -1 }],
    ["nothing at all", null]
  ])("should drop an entry with %s and keep the rest of the report", (_what, bad) => {
    expect(readReportedFiles([bad, { upload_id: OTHER, bytes: 7 }])).toEqual([{ upload_id: OTHER, bytes: 7 }]);
  });

  it.each([
    ["a string", "files"],
    ["nothing", undefined],
    ["null", null]
  ] as const)("should read %s as no files when that is what arrives", (_what, value) => {
    expect(readReportedFiles(value)).toEqual([]);
  });

  it("should keep only the first entries when a pod reports more than a report holds", () => {
    const many = Array.from({ length: MAX_REPORTED_FILES + 5 }, (_, index) => ({ upload_id: ID, bytes: index }));

    expect(readReportedFiles(many)).toHaveLength(MAX_REPORTED_FILES);
  });
});

describe("uploadsDisk", () => {
  it("should give the pod's figures, dated, when it has reported and is running", () => {
    expect(uploadsDisk(row())).toEqual({
      reported: true,
      uploadsBytes: 2_254_857_830,
      volumeUsedBytes: 30_477_004_800,
      volumeTotalBytes: 34_359_738_368,
      at: "2026-10-29T09:00:00.000Z",
      stopped: false
    });
  });

  // The files are still on the volume, so the figures are shown — but a stopped pod will not move them, and the
  // section says so rather than leaving someone waiting for a number that cannot change.
  it("should still give the figures, marked as from a stopped assistant, when the pod has stopped since reporting", () => {
    expect(uploadsDisk(row({ running: false }))).toMatchObject({ reported: true, stopped: true });
  });

  // The client comes first: a pod on an older build would otherwise read as one that is merely slow to answer, and
  // the person would wait for a report that can never come.
  it("should say the client is too old, rather than that it is waiting, when the pod cannot report at all", () => {
    expect(uploadsDisk(row({ uploadsReportedAt: null, uploadsBytes: null, volumeUsedBytes: null, volumeTotalBytes: null, reports: false }))).toEqual({
      reported: false,
      reason: "older_client"
    });
  });

  it("should say nothing has looked when the pod is stopped and has never reported", () => {
    expect(uploadsDisk(row({ uploadsReportedAt: null, uploadsBytes: null, volumeUsedBytes: null, volumeTotalBytes: null, running: false }))).toEqual({
      reported: false,
      reason: "not_running"
    });
  });

  it("should say it is waiting when the pod is running and has not reported yet", () => {
    expect(uploadsDisk(row({ uploadsReportedAt: null, uploadsBytes: null, volumeUsedBytes: null, volumeTotalBytes: null }))).toEqual({
      reported: false,
      reason: "waiting"
    });
  });

  // A half-written report is no report. Showing one figure and a zero beside it would read as a volume that is empty.
  it.each(["uploadsBytes", "volumeUsedBytes", "volumeTotalBytes"] as const)("should report nothing when %s is missing from the stored report", (missing) => {
    expect(uploadsDisk(row({ [missing]: null }))).toEqual({ reported: false, reason: "waiting" });
  });
});
