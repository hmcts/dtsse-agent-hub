import { describe, expect, it } from "vitest";
import {
  attachedBody,
  DEFAULT_MEDIA_TYPE,
  describeBytes,
  fileNameOf,
  isMediaType,
  isUploadSize,
  MAX_STORED_NAME,
  MAX_UPLOAD_BYTES,
  PART_BYTES,
  partCount,
  partIndexOf,
  partLength,
  storedNameOf
} from "./uploads.ts";

describe("the part size", () => {
  it("should be 4 MiB, the size the ingress read timeout allows for", () => {
    expect(PART_BYTES).toBe(4 * 1024 * 1024);
  });

  it("should cut a file into whole parts and a remainder", () => {
    expect(partCount(1)).toBe(1);
    expect(partCount(PART_BYTES)).toBe(1);
    expect(partCount(PART_BYTES + 1)).toBe(2);
    expect(partCount(MAX_UPLOAD_BYTES)).toBe(7);
  });

  it("should give every part but the last the full size", () => {
    expect(partLength(PART_BYTES * 2 + 17, 0)).toBe(PART_BYTES);
    expect(partLength(PART_BYTES * 2 + 17, 1)).toBe(PART_BYTES);
    expect(partLength(PART_BYTES * 2 + 17, 2)).toBe(17);
  });
});

describe("partIndexOf", () => {
  it("should read a part number inside the file", () => {
    expect(partIndexOf("0", PART_BYTES + 1)).toBe(0);
    expect(partIndexOf("1", PART_BYTES + 1)).toBe(1);
  });

  it("should refuse a part number past the end of the file", () => {
    expect(partIndexOf("2", PART_BYTES + 1)).toBeUndefined();
  });

  it("should refuse anything that is not a short whole number", () => {
    expect(partIndexOf("", 10)).toBeUndefined();
    expect(partIndexOf("-1", 10)).toBeUndefined();
    expect(partIndexOf("1.5", 10)).toBeUndefined();
    expect(partIndexOf("00000", 10)).toBeUndefined();
    expect(partIndexOf("abc", 10)).toBeUndefined();
  });
});

describe("isUploadSize", () => {
  it("should accept a whole number of bytes up to the cap", () => {
    expect(isUploadSize(1)).toBe(true);
    expect(isUploadSize(MAX_UPLOAD_BYTES)).toBe(true);
  });

  it("should refuse an empty file, an oversized one and anything that is not a whole number", () => {
    expect(isUploadSize(0)).toBe(false);
    expect(isUploadSize(MAX_UPLOAD_BYTES + 1)).toBe(false);
    expect(isUploadSize(1.5)).toBe(false);
    expect(isUploadSize("10")).toBe(false);
    expect(isUploadSize(undefined)).toBe(false);
  });
});

describe("isMediaType", () => {
  it("should accept the shapes a browser sends", () => {
    expect(isMediaType("application/pdf")).toBe(true);
    expect(isMediaType("image/png")).toBe(true);
    expect(isMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(true);
    expect(isMediaType(DEFAULT_MEDIA_TYPE)).toBe(true);
    expect(isMediaType("IMAGE/PNG")).toBe(true);
  });

  it("should refuse anything that is not one type over one subtype", () => {
    expect(isMediaType("application")).toBe(false);
    expect(isMediaType("/png")).toBe(false);
    expect(isMediaType("image/")).toBe(false);
    expect(isMediaType("image/png; charset=utf-8")).toBe(false);
    expect(isMediaType(7)).toBe(false);
  });
});

describe("storedNameOf", () => {
  it("should keep a plain file name as it is", () => {
    expect(storedNameOf("letter.pdf")).toBe("letter.pdf");
    expect(storedNameOf("Scan_2026-10-25.PNG")).toBe("Scan_2026-10-25.PNG");
  });

  it("should take out every path separator and traversal segment", () => {
    expect(storedNameOf("../../etc/passwd")).toBe("etc_passwd");
    expect(storedNameOf("/absolute/path.txt")).toBe("absolute_path.txt");
    expect(storedNameOf("c:\\windows\\system32")).toBe("c_windows_system32");
  });

  it("should never produce a dotfile or an empty name", () => {
    expect(storedNameOf(".bashrc")).toBe("bashrc");
    expect(storedNameOf("...")).toBe("file");
    expect(storedNameOf("")).toBe("file");
    expect(storedNameOf("中文")).toBe("file");
    expect(storedNameOf(undefined)).toBe("file");
    expect(storedNameOf(42)).toBe("file");
  });

  it("should replace spaces and anything else unprintable", () => {
    expect(storedNameOf("my report (final).docx")).toBe("my_report_final_.docx");
    expect(storedNameOf("a\u0000b.txt")).toBe("a_b.txt");
    expect(storedNameOf("new\nline.txt")).toBe("new_line.txt");
  });

  it("should keep the extension when the name has to be cut", () => {
    const stored = storedNameOf(`${"a".repeat(200)}.pdf`);
    expect(stored.length).toBe(MAX_STORED_NAME);
    expect(stored.endsWith(".pdf")).toBe(true);
  });

  it("should still cut a name that is too long and has no extension to keep", () => {
    expect(storedNameOf("b".repeat(200))).toBe("b".repeat(MAX_STORED_NAME));
  });

  it("should match the pattern the assistant_upload CHECK constraint allows", () => {
    for (const name of ["../x", ".hidden", "a b", "", "é.pdf", `${"z".repeat(300)}.csv`]) {
      expect(storedNameOf(name)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
    }
  });
});

describe("fileNameOf", () => {
  it("should keep the name the person's file had, spaces and all", () => {
    expect(fileNameOf("my report (final).docx")).toBe("my report (final).docx");
    expect(fileNameOf("中文.pdf")).toBe("中文.pdf");
  });

  it("should take out control characters and trim", () => {
    expect(fileNameOf("  a\u0000b\n.txt  ")).toBe("ab.txt");
  });

  it("should fall back to a name when there is nothing printable", () => {
    expect(fileNameOf("   ")).toBe("file");
    expect(fileNameOf(null)).toBe("file");
  });
});

describe("describeBytes", () => {
  it("should read as whole megabytes when it divides, and one decimal otherwise", () => {
    expect(describeBytes(MAX_UPLOAD_BYTES)).toBe("25 MB");
    expect(describeBytes(PART_BYTES)).toBe("4 MB");
    expect(describeBytes(1_500_000)).toBe("1.4 MB");
  });
});

describe("attachedBody", () => {
  it("should say a file when a message carries a single one", () => {
    expect(attachedBody(["letter.pdf"])).toBe("I have attached a file. Please take a look.");
  });

  it("should count the files when a message carries several", () => {
    expect(attachedBody(["a.pdf", "b.pdf", "c.pdf", "d.pdf"])).toBe("I have attached 4 files. Please take a look.");
  });

  // The names belong to the chips beside the message, which are the owner's to see. This body is the one in the hub
  // its sender did not write, and a read-only share of their conversation carries it.
  it("should name no file, whatever they were called", () => {
    expect(attachedBody(["grievance-smith-2026.pdf", "scan.png"])).toBe("I have attached 2 files. Please take a look.");
  });

  it("should give nothing when there are no files, so the caller refuses the send rather than write an empty message", () => {
    expect(attachedBody([])).toBe("");
  });
});
