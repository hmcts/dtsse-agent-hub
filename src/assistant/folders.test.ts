import { describe, expect, it } from "vitest";
import { byFolderName, FOLDER_NAME_MAX, folderHref, folderName, withChats } from "./folders.ts";

describe("folderName", () => {
  it("should trim the name and collapse its whitespace", () => {
    expect(folderName("  Possession   claims \n")).toBe("Possession claims");
  });

  it("should refuse a name that is blank once trimmed", () => {
    expect(folderName("   ")).toBeNull();
  });

  it("should refuse a name longer than the limit", () => {
    expect(folderName("a".repeat(FOLDER_NAME_MAX))).toBe("a".repeat(FOLDER_NAME_MAX));
    expect(folderName("a".repeat(FOLDER_NAME_MAX + 1))).toBeNull();
  });

  it("should refuse anything that is not a string", () => {
    expect(folderName(42)).toBeNull();
    expect(folderName(undefined)).toBeNull();
  });
});

describe("withChats", () => {
  it("should put each chat under its folder in the order given, and give an empty folder no chats", () => {
    const folders = [
      { id: "a", name: "A" },
      { id: "b", name: "B" }
    ];
    const chats = [
      { id: "1", folderId: "a" },
      { id: "2", folderId: "b" },
      { id: "3", folderId: "a" },
      { id: "4", folderId: null },
      { id: "5", folderId: "gone" }
    ];

    expect(withChats(folders, chats)).toEqual([
      { id: "a", name: "A", chats: [chats[0], chats[2]] },
      { id: "b", name: "B", chats: [chats[1]] }
    ]);
    expect(withChats(folders, [])).toEqual([
      { id: "a", name: "A", chats: [] },
      { id: "b", name: "B", chats: [] }
    ]);
  });
});

describe("folderHref", () => {
  it("should point at the folder's own page", () => {
    expect(folderHref("f1")).toBe("/assistant/folders/f1");
  });
});

describe("byFolderName", () => {
  it("should order folders by name regardless of case", () => {
    const folders = [
      { id: "2", name: "beta" },
      { id: "1", name: "Alpha" },
      { id: "3", name: "Gamma" }
    ];
    expect(folders.sort(byFolderName).map((folder) => folder.name)).toEqual(["Alpha", "beta", "Gamma"]);
  });

  it("should settle a tie on the id when two folders have the same name", () => {
    const folders = [
      { id: "b", name: "Same" },
      { id: "a", name: "same" }
    ];
    expect(folders.sort(byFolderName).map((folder) => folder.id)).toEqual(["a", "b"]);
    expect(byFolderName({ id: "a", name: "x" }, { id: "a", name: "x" })).toBe(0);
  });
});
