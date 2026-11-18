import { describe, expect, it } from "vitest";
import { documentExports, documentLabel, isDocumentKind, primaryDocument } from "./documents.ts";

describe("isDocumentKind", () => {
  it("should accept each kind and refuse anything else", () => {
    expect(["document", "ticket", "confluence"].every(isDocumentKind)).toBe(true);
    expect(isDocumentKind("deck")).toBe(false);
    expect(isDocumentKind(undefined)).toBe(false);
  });
});

describe("documentExports", () => {
  it("should offer both destinations when the document is a plain one", () => {
    expect(documentExports("document")).toEqual({ ticket: true, confluence: true });
  });

  it("should offer only the ticket tool when the document is a ticket", () => {
    expect(documentExports("ticket")).toEqual({ ticket: true, confluence: false });
  });

  it("should offer only Confluence when the document is a Confluence page", () => {
    expect(documentExports("confluence")).toEqual({ ticket: false, confluence: true });
  });
});

describe("primaryDocument", () => {
  it("should answer the oldest plain document when tickets and pages come before it", () => {
    const documents = [
      { id: "a", kind: "ticket" },
      { id: "b", kind: "document" },
      { id: "c", kind: "document" }
    ];

    expect(primaryDocument(documents)?.id).toBe("b");
  });

  it("should answer none when the conversation has no plain document", () => {
    expect(primaryDocument([{ id: "a", kind: "confluence" }])).toBeUndefined();
  });
});

describe("documentLabel", () => {
  it("should name a plain document by its title alone", () => {
    expect(documentLabel("document", "Plan", "jira")).toBe("Plan");
  });

  it("should mark a ticket with the person's ticket tool when it is one", () => {
    expect(documentLabel("ticket", "Story", "jira")).toBe("Jira: Story");
    expect(documentLabel("ticket", "Story", "github")).toBe("GitHub: Story");
  });

  it("should mark a Confluence page, and name an untitled one, when it has no title", () => {
    expect(documentLabel("confluence", null, "jira")).toBe("Confluence: Untitled document");
  });
});
