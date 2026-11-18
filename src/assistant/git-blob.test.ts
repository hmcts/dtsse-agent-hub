import { describe, expect, it } from "vitest";
import { gitBlobSha1 } from "./git-blob.ts";

describe("gitBlobSha1", () => {
  it("should hash bytes as git names a blob when they are text", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha1(new TextEncoder().encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it("should hash an empty file as git's empty blob when there are no bytes", () => {
    expect(gitBlobSha1(new Uint8Array())).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("should count bytes rather than characters in the header when the bytes are not ASCII", () => {
    // `printf 'é' | git hash-object --stdin`: two bytes, one character.
    expect(gitBlobSha1(new TextEncoder().encode("é"))).toBe("4b04fff51468d8ab5201ab02b725dc477bc7cb45");
  });
});
