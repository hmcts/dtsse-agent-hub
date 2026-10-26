import { describe, expect, it } from "vitest";
import { sharedThreadItems } from "./sharing.ts";
import type { ThreadItem } from "./thread.ts";

const ATTACHMENT = { id: "upload-1", name: "medical-report.pdf", bytes: 2048, media_type: "application/pdf" };

const user = (overrides: Partial<Extract<ThreadItem, { type: "user" }>> = {}): ThreadItem => ({
  type: "user",
  key: "m1",
  at: "2026-10-25T09:00:00.000Z",
  text: "Can you draft an order?",
  delivery: "delivered",
  attachments: [],
  ...overrides
});

describe("sharedThreadItems", () => {
  it("should keep what the person and the assistant said when the thread is shared", () => {
    const thread: ThreadItem[] = [user(), { type: "assistant", key: "t2", at: "2026-10-25T09:00:01.000Z", text: "Here is a draft." }];

    expect(sharedThreadItems(thread)).toEqual([
      { type: "user", key: "m1", at: "2026-10-25T09:00:00.000Z", text: "Can you draft an order?", attachmentCount: 0 },
      { type: "assistant", key: "t2", at: "2026-10-25T09:00:01.000Z", text: "Here is a draft." }
    ]);
  });

  it("should keep a product change, which says what the chat was about from there on", () => {
    const thread: ThreadItem[] = [{ type: "product", key: "p1", at: "2026-10-25T09:00:00.000Z", label: "Possession" }];

    expect(sharedThreadItems(thread)).toEqual(thread);
  });

  // Without it the shared thread would end an answer mid-thought with nothing to say why.
  it("should keep where the owner stopped an answer", () => {
    const thread: ThreadItem[] = [{ type: "stopped", key: "s1", at: "2026-10-25T09:00:02.000Z" }];

    expect(sharedThreadItems(thread)).toEqual(thread);
  });

  it("should reduce the files on a message to how many there were, naming none of them", () => {
    const shared = sharedThreadItems([user({ attachments: [ATTACHMENT, { ...ATTACHMENT, id: "upload-2", name: "tenancy.docx" }] })]);

    expect(shared).toEqual([{ type: "user", key: "m1", at: "2026-10-25T09:00:00.000Z", text: "Can you draft an order?", attachmentCount: 2 }]);
    expect(JSON.stringify(shared)).not.toContain("medical-report.pdf");
    expect(JSON.stringify(shared)).not.toContain("tenancy.docx");
  });

  it("should leave out the delivery state, which is the owner's to act on", () => {
    expect(sharedThreadItems([user({ delivery: "expired" })])[0]).not.toHaveProperty("delivery");
  });

  it("should carry nothing of an upload's size or type, whatever was attached", () => {
    expect(JSON.stringify(sharedThreadItems([user({ attachments: [ATTACHMENT] })]))).not.toContain("application/pdf");
  });
});
