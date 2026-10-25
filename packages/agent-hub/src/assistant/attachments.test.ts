// The pod's half of attachments: where a file is written, what the hub is believed about it, and what the envelope is
// told when a fetch fails. The hub's half is in dtsse-agent-hub's `test/integration/assistant-uploads.test.ts`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentLines } from "../envelope.ts";
import {
  type Attachment,
  attachmentPath,
  conversationDir,
  fetchAttachments,
  parseAttachments,
  readAttachments,
  reconcileUploads,
  removeConversationUploads,
  safeName,
  staleUploadDirs,
  unfetchedAttachments,
  uploadsRoot
} from "./attachments.ts";

const CONVERSATION = "11111111-2222-3333-4444-555555555555";
const UPLOAD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-uploads-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    fs.rmSync(roots.pop() as string, { recursive: true, force: true });
  }
});

function attachment(overrides: Partial<Attachment> = {}): Attachment {
  return { uploadId: UPLOAD, name: "letter.pdf", bytes: 10, mediaType: "application/pdf", parts: 1, ...overrides };
}

/** An api that serves `bytes` in `parts` slices, and records what it was told. */
function fakeApi(bytes: Uint8Array, parts: number) {
  const size = Math.ceil(bytes.byteLength / parts);
  const fetched: string[] = [];
  const asked: number[] = [];
  return {
    fetched,
    asked,
    attachmentPart: async (_agentId: string, _uploadId: string, index: number) => {
      asked.push(index);
      return bytes.subarray(index * size, Math.min(bytes.byteLength, (index + 1) * size));
    },
    attachmentFetched: async (_agentId: string, uploadId: string) => {
      fetched.push(uploadId);
      return null;
    }
  };
}

describe("safeName", () => {
  it("should keep a plain name", () => {
    expect(safeName("letter.pdf")).toBe("letter.pdf");
  });

  it("should take out every separator and traversal segment, as the hub's own sanitiser does", () => {
    expect(safeName("../../etc/passwd")).toBe("etc_passwd");
    expect(safeName("a\\b")).toBe("a_b");
  });

  it("should never produce a dotfile or an empty name", () => {
    expect(safeName(".ssh")).toBe("ssh");
    expect(safeName("..")).toBe("file");
    expect(safeName("")).toBe("file");
  });

  it("should cut a name that is too long for a path", () => {
    expect(safeName("x".repeat(500)).length).toBe(100);
  });
});

describe("uploadsRoot", () => {
  it("should sit beside the workspace checkout, on the volume rather than in the clone", () => {
    expect(uploadsRoot({}, "/workspace/cft-workspace")).toBe(path.join("/workspace", "uploads"));
  });

  it("should take an override from the environment", () => {
    expect(uploadsRoot({ AGENT_HUB_UPLOADS_DIR: "/data/up" }, "/workspace/cft-workspace")).toBe("/data/up");
  });
});

describe("conversationDir", () => {
  it("should be the conversation's own directory under the root", () => {
    expect(conversationDir("/workspace/uploads", CONVERSATION)).toBe(path.join("/workspace/uploads", CONVERSATION));
  });

  it("should refuse a conversation id that is not a UUID rather than make it into a path", () => {
    expect(() => conversationDir("/workspace/uploads", "../etc")).toThrow("is not a conversation id");
  });
});

describe("attachmentPath", () => {
  it("should name the file by its upload id and stored name", () => {
    expect(attachmentPath("/workspace/uploads", CONVERSATION, UPLOAD, "letter.pdf")).toBe(
      path.join("/workspace/uploads", CONVERSATION, `${UPLOAD}-letter.pdf`)
    );
  });

  it("should resolve inside the conversation's directory whatever the name says", () => {
    const file = attachmentPath("/workspace/uploads", CONVERSATION, UPLOAD, "../../../etc/passwd");
    expect(file.startsWith(path.join("/workspace/uploads", CONVERSATION) + path.sep)).toBe(true);
    expect(file).not.toContain("..");
  });

  it("should refuse an upload id that is not a UUID", () => {
    expect(() => attachmentPath("/workspace/uploads", CONVERSATION, "../x", "a.pdf")).toThrow("is not an upload id");
  });

  it("should be a pure function of its arguments", () => {
    expect(attachmentPath("/r", CONVERSATION, UPLOAD, "a.pdf")).toBe(attachmentPath("/r", CONVERSATION, UPLOAD, "a.pdf"));
  });
});

describe("parseAttachments", () => {
  const whole = { upload_id: UPLOAD, name: "letter.pdf", bytes: 10, media_type: "application/pdf", part_bytes: 10, parts: 1 };

  it("should read an attachment the hub described in full", () => {
    expect(parseAttachments([whole])).toEqual([{ uploadId: UPLOAD, name: "letter.pdf", bytes: 10, mediaType: "application/pdf", parts: 1 }]);
  });

  it("should work out the part count when the hub sent only the part size", () => {
    expect(parseAttachments([{ ...whole, bytes: 25, part_bytes: 10, parts: undefined }])[0]?.parts).toBe(3);
  });

  it("should default the media type when the hub left it out", () => {
    expect(parseAttachments([{ ...whole, media_type: undefined }])[0]?.mediaType).toBe("application/octet-stream");
  });

  it("should read nothing from a frame that carries no attachments", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments(null)).toEqual([]);
    expect(parseAttachments({})).toEqual([]);
    expect(parseAttachments([])).toEqual([]);
  });

  it.each([
    ["an entry that is not an object", "nope"],
    ["an upload id that is not a UUID", { ...whole, upload_id: "x" }],
    ["no name", { ...whole, name: "" }],
    ["no size", { ...whole, bytes: undefined }],
    ["a fractional size", { ...whole, bytes: 1.5 }],
    ["a size past the cap", { ...whole, bytes: 26 * 1024 * 1024 }],
    ["no part size", { ...whole, part_bytes: undefined }],
    ["a part size of zero", { ...whole, part_bytes: 0 }],
    ["a part count that disagrees with the size", { ...whole, parts: 3 }]
  ])("should drop %s rather than act on half an attachment", (_label, entry) => {
    expect(parseAttachments([entry])).toEqual([]);
  });

  it("should take at most four, which is the hub's own cap per message", () => {
    expect(parseAttachments(Array.from({ length: 9 }, () => whole))).toHaveLength(4);
  });

  it("should fall back to a part size the caller knows when the frame omits it", () => {
    expect(parseAttachments([{ ...whole, part_bytes: undefined, parts: undefined, bytes: 20 }], 10)[0]?.parts).toBe(2);
  });
});

describe("readAttachments", () => {
  const whole = { upload_id: UPLOAD, name: "letter.pdf", bytes: 10, media_type: "application/pdf", part_bytes: 10, parts: 1 };

  it("should carry nothing dropped when every entry is one this client acts on", () => {
    expect(readAttachments([whole])).toEqual({
      attachments: [{ uploadId: UPLOAD, name: "letter.pdf", bytes: 10, mediaType: "application/pdf", parts: 1 }],
      dropped: []
    });
  });

  it.each([
    ["an entry that is not an object", "nope", "an unnamed file"],
    ["an upload id that is not a UUID", { ...whole, upload_id: "x" }, "letter.pdf"],
    ["no name", { ...whole, name: "" }, "an unnamed file"],
    ["no size", { ...whole, bytes: undefined }, "letter.pdf"],
    ["a size past the cap", { ...whole, bytes: 26 * 1024 * 1024 }, "letter.pdf"],
    ["no part size", { ...whole, part_bytes: undefined }, "letter.pdf"],
    ["a part count that disagrees with the size", { ...whole, parts: 3 }, "letter.pdf"]
  ])("should answer with an error outcome for %s, so the envelope names it rather than saying nothing", (_label, entry, name) => {
    const { attachments, dropped } = readAttachments([entry]);

    expect(attachments).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.name).toBe(name);
    expect(attachmentLines(dropped).join("\n")).toContain(`could not be retrieved and is not on this machine: ${name}`);
  });

  it("should say nothing about the entries past the hub's own cap of four, which no hub can send", () => {
    expect(readAttachments(Array.from({ length: 9 }, () => whole)).dropped).toEqual([]);
  });

  it("should read nothing, and refuse nothing, from a frame that carries no attachments", () => {
    expect(readAttachments(undefined)).toEqual({ attachments: [], dropped: [] });
    expect(readAttachments([])).toEqual({ attachments: [], dropped: [] });
  });
});

describe("unfetchedAttachments", () => {
  it("should word each file as one the envelope says could not be retrieved", () => {
    const lines = attachmentLines(unfetchedAttachments([attachment({ name: "a letter.pdf" })], "no agent id")).join("\n");

    expect(unfetchedAttachments([attachment()], "no agent id")).toEqual([
      { name: "letter.pdf", media_type: "application/pdf", bytes: 10, error: "no agent id" }
    ]);
    expect(lines).toContain("A file the user attached could not be retrieved and is not on this machine: a_letter.pdf.");
    expect(lines).toContain("ask them to attach it again");
  });
});

describe("fetchAttachments", () => {
  it("should write the file part by part at 0600 and report it fetched", async () => {
    // Arrange
    const root = tempRoot();
    const bytes = new Uint8Array(10).fill(3);
    const api = fakeApi(bytes, 4);

    // Act
    const outcomes = await fetchAttachments({
      api,
      agentId: "agent-1",
      conversationId: CONVERSATION,
      attachments: [attachment({ parts: 4 })],
      root
    });

    // Assert
    const file = attachmentPath(root, CONVERSATION, UPLOAD, "letter.pdf");
    expect(outcomes).toEqual([{ name: "letter.pdf", path: file, media_type: "application/pdf", bytes: 10 }]);
    expect([...fs.readFileSync(file)]).toEqual([...bytes]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(api.fetched).toEqual([UPLOAD]);
    expect(api.asked).toEqual([0, 1, 2, 3]);
  });

  it("should report the file could not be retrieved when a part cannot be fetched, rather than drop it", async () => {
    // Arrange
    const root = tempRoot();
    const api = {
      attachmentPart: async () => {
        throw new Error("503 from the hub");
      },
      attachmentFetched: async () => null
    };
    const said: string[] = [];

    // Act
    const outcomes = await fetchAttachments({
      api,
      agentId: "agent-1",
      conversationId: CONVERSATION,
      attachments: [attachment()],
      root,
      say: (m) => said.push(m)
    });

    // Assert
    expect(outcomes).toEqual([{ name: "letter.pdf", media_type: "application/pdf", bytes: 10, error: "503 from the hub" }]);
    expect(said.some((m) => m.includes("could not fetch letter.pdf: 503 from the hub"))).toBe(true);
  });

  it("should still tell the session where the file is when the fetched report fails, since the bytes are on this disk", async () => {
    // Arrange: every part arrives and the length checks out, then the report is lost — a transient 5xx or a dropped
    // connection. The hub keeps its part rows a while longer and its sweep is the backstop for them.
    const root = tempRoot();
    const bytes = new Uint8Array(10).fill(9);
    const api = {
      attachmentPart: async () => bytes,
      attachmentFetched: async () => {
        throw new Error("502 from the hub");
      }
    };
    const said: string[] = [];

    // Act
    const outcomes = await fetchAttachments({
      api,
      agentId: "agent-1",
      conversationId: CONVERSATION,
      attachments: [attachment()],
      root,
      say: (m) => said.push(m)
    });
    const lines = attachmentLines(outcomes).join("\n");

    // Assert: the envelope names the path and tells the session to read it, and says nothing about a file that could
    // not be retrieved — the file is there, complete, so asking the person to attach it again would ask for nothing.
    const file = attachmentPath(root, CONVERSATION, UPLOAD, "letter.pdf");
    expect(lines).toContain("already saved on this machine");
    expect(lines).toContain(`- ${file} (application/pdf,`);
    expect(lines).not.toContain("could not be retrieved");
    expect(outcomes).toEqual([{ name: "letter.pdf", path: file, media_type: "application/pdf", bytes: 10 }]);
    expect([...fs.readFileSync(file)]).toEqual([...bytes]);
    // Logged, because the hub is still holding bytes nothing has told it to drop.
    expect(said.some((m) => m.includes("saved letter.pdf, but could not report it fetched: 502 from the hub"))).toBe(true);
  });

  it("should refuse to report fetched when the bytes do not add up to what the frame claimed", async () => {
    // Arrange
    const root = tempRoot();
    const api = fakeApi(new Uint8Array(4).fill(1), 1);

    // Act
    const outcomes = await fetchAttachments({ api, agentId: "agent-1", conversationId: CONVERSATION, attachments: [attachment({ bytes: 10 })], root });

    // Assert
    expect(outcomes[0]?.error).toBe("wrote 4 bytes of an expected 10");
    expect(api.fetched).toEqual([]);
  });

  it("should stop a part that would take the file past the claimed length", async () => {
    // Arrange
    const root = tempRoot();
    const api = {
      attachmentPart: async () => new Uint8Array(50).fill(9),
      attachmentFetched: async () => null
    };

    // Act
    const outcomes = await fetchAttachments({ api, agentId: "agent-1", conversationId: CONVERSATION, attachments: [attachment({ bytes: 10 })], root });

    // Assert
    expect(outcomes[0]?.error).toContain("past the expected 10 bytes");
  });

  it("should keep a file it already has at full length, since the parts are gone once it was reported", async () => {
    // Arrange: the hub replayed an unacked message, so the file is already on disk and its parts have been deleted.
    const root = tempRoot();
    const file = attachmentPath(root, CONVERSATION, UPLOAD, "letter.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, new Uint8Array(10).fill(4));
    const api = {
      attachmentPart: async () => {
        throw new Error("404 no such part of this file");
      },
      attachmentFetched: async () => null
    };

    // Act
    const outcomes = await fetchAttachments({ api, agentId: "agent-1", conversationId: CONVERSATION, attachments: [attachment()], root });

    // Assert
    expect(outcomes).toEqual([{ name: "letter.pdf", path: file, media_type: "application/pdf", bytes: 10 }]);
  });

  it("should fetch each of several attachments and answer about each in turn", async () => {
    // Arrange
    const root = tempRoot();
    const second = "ffffffff-eeee-dddd-cccc-bbbbbbbbbbbb";
    const api = {
      attachmentPart: async (_a: string, uploadId: string) => (uploadId === UPLOAD ? new Uint8Array(10).fill(1) : new Uint8Array(2).fill(2)),
      attachmentFetched: async () => null
    };

    // Act
    const outcomes = await fetchAttachments({
      api,
      agentId: "agent-1",
      conversationId: CONVERSATION,
      attachments: [attachment(), attachment({ uploadId: second, name: "scan.png", bytes: 2, mediaType: "image/png" })],
      root
    });

    // Assert
    expect(outcomes.map((outcome) => outcome.name)).toEqual(["letter.pdf", "scan.png"]);
    expect(outcomes.every((outcome) => typeof outcome.path === "string")).toBe(true);
  });

  it("should answer with an error rather than throw when the conversation id could not be a directory", async () => {
    // Act
    const outcomes = await fetchAttachments({
      api: fakeApi(new Uint8Array(10), 1),
      agentId: "agent-1",
      conversationId: "../escape",
      attachments: [attachment()],
      root: tempRoot()
    });

    // Assert
    expect(outcomes[0]?.error).toContain("is not a conversation id");
  });

  it("should read the root from the environment when it is not given one", async () => {
    // Arrange
    const root = tempRoot();

    // Act
    const outcomes = await fetchAttachments({
      api: fakeApi(new Uint8Array(10).fill(1), 1),
      agentId: "agent-1",
      conversationId: CONVERSATION,
      attachments: [attachment()],
      env: { AGENT_HUB_UPLOADS_DIR: root }
    });

    // Assert
    expect(outcomes[0]?.path).toBe(attachmentPath(root, CONVERSATION, UPLOAD, "letter.pdf"));
  });
});

describe("removeConversationUploads", () => {
  it("should delete the conversation's directory and everything in it", () => {
    // Arrange
    const root = tempRoot();
    const file = attachmentPath(root, CONVERSATION, UPLOAD, "letter.pdf");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "x");

    // Act
    removeConversationUploads(root, CONVERSATION);

    // Assert
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });

  it("should treat a conversation with no uploads as already done", () => {
    expect(() => removeConversationUploads(tempRoot(), CONVERSATION)).not.toThrow();
  });
});

describe("staleUploadDirs", () => {
  const other = "99999999-8888-7777-6666-555555555555";

  it("should name the conversations the hub no longer has", () => {
    expect(staleUploadDirs([CONVERSATION, other], [other])).toEqual([CONVERSATION]);
  });

  it("should keep every live conversation, whatever case its directory is in", () => {
    expect(staleUploadDirs([CONVERSATION.toUpperCase()], [CONVERSATION])).toEqual([]);
  });

  it("should leave alone anything whose name is not a conversation id", () => {
    expect(staleUploadDirs(["README.md", ".keep", "tmp"], [])).toEqual([]);
  });
});

describe("reconcileUploads", () => {
  function withDirs(...ids: string[]): string {
    const root = tempRoot();
    for (const id of ids) {
      fs.mkdirSync(path.join(root, id), { recursive: true });
    }
    return root;
  }

  it("should remove the uploads of a conversation deleted while this pod was stopped", async () => {
    // Arrange
    const gone = "99999999-8888-7777-6666-555555555555";
    const root = withDirs(CONVERSATION, gone);
    const said: string[] = [];

    // Act
    const removed = await reconcileUploads({
      api: { conversations: async () => ({ conversations: [{ id: CONVERSATION }] }) },
      id: "va-1",
      root,
      say: (m) => said.push(m)
    });

    // Assert
    expect(removed).toBe(1);
    expect(fs.existsSync(path.join(root, gone))).toBe(false);
    expect(fs.existsSync(path.join(root, CONVERSATION))).toBe(true);
    expect(said).toEqual([`removed the uploads of conversation ${gone}, which the hub no longer has`]);
  });

  it("should remove nothing when the conversation list cannot be read, since that is not an empty list", async () => {
    // Arrange
    const root = withDirs(CONVERSATION);
    const said: string[] = [];

    // Act
    const removed = await reconcileUploads({
      api: {
        conversations: async () => {
          throw new Error("503 from the hub");
        }
      },
      id: "va-1",
      root,
      say: (m) => said.push(m)
    });

    // Assert
    expect(removed).toBe(0);
    expect(fs.existsSync(path.join(root, CONVERSATION))).toBe(true);
    expect(said).toEqual(["could not read the conversation list to reconcile uploads: 503 from the hub"]);
  });

  it("should do nothing when no file has ever been attached on this pod", async () => {
    // Arrange
    let asked = false;

    // Act
    const removed = await reconcileUploads({
      api: {
        conversations: async () => {
          asked = true;
          return { conversations: [] };
        }
      },
      id: "va-1",
      root: path.join(tempRoot(), "never-made")
    });

    // Assert
    expect(removed).toBe(0);
    expect(asked).toBe(false);
  });

  it("should say which directory it could not remove and carry on with the rest", async () => {
    // Arrange
    const gone = "99999999-8888-7777-6666-555555555555";
    const alsoGone = "77777777-6666-5555-4444-333333333333";
    const root = withDirs(gone, alsoGone);
    const said: string[] = [];

    // Act
    const removed = await reconcileUploads({
      api: { conversations: async () => ({ conversations: [] }) },
      id: "va-1",
      root,
      say: (m) => said.push(m),
      fs: {
        ...fs,
        rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
          if (String(target).endsWith(gone)) {
            throw new Error("read-only file system");
          }
          fs.rmSync(target, options);
        }
      }
    });

    // Assert
    expect(removed).toBe(1);
    expect(said.some((m) => m === `could not remove the uploads of conversation ${gone}: read-only file system`)).toBe(true);
    expect(fs.existsSync(path.join(root, alsoGone))).toBe(false);
  });

  it("should read the root from the environment when it is not given one", async () => {
    // Arrange
    const gone = "99999999-8888-7777-6666-555555555555";
    const root = withDirs(gone);

    // Act
    const removed = await reconcileUploads({
      api: { conversations: async () => ({ conversations: [] }) },
      id: "va-1",
      env: { AGENT_HUB_UPLOADS_DIR: root }
    });

    // Assert
    expect(removed).toBe(1);
  });
});
