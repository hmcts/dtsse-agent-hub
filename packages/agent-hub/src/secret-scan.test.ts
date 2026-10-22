// The JavaScript half of the shared secret scan. cft-workspace keeps the other half — `scripts/lib/_secret_scan.sh`
// and the `knowledge-sweep` flow that sources it — against its own twin of `secret-patterns`, so the parity tests
// that spawn bash stayed there with the code they exercise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { fakeSecrets } from "./__fixtures__/claude-home.ts";
import { containsSecret, findSecret, loadPatterns, PATTERNS_FILE, parsePatterns } from "./secret-scan.ts";

const clean = ["nothing to see here", "password: short", "the api key lives in Key Vault", "eyJshort."];

const temporary: string[] = [];

function patternFile(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-patterns-"));
  temporary.push(dir);
  const file = path.join(dir, "secret-patterns");
  fs.writeFileSync(file, text);
  return file;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("PATTERNS_FILE", () => {
  it("should resolve one directory above the module when the package is installed anywhere", () => {
    // Assert: the same relative step `dist/secret-scan.js` takes to reach the package root.
    expect(PATTERNS_FILE).toBe(fileURLToPath(new URL("../secret-patterns", import.meta.url)));
    expect(fs.existsSync(PATTERNS_FILE)).toBe(true);
  });
});

describe("loadPatterns", () => {
  it("should parse the shipped pattern file and skip its comments when given no file", () => {
    // Act
    const patterns = loadPatterns();

    // Assert
    // Pinned deliberately: the count changing is how a drift from the cft-workspace twin gets noticed.
    expect(patterns).toHaveLength(7);
    expect(patterns.some((p) => p.source.startsWith("ABSK"))).toBe(true);
    expect(
      fs
        .readFileSync(PATTERNS_FILE, "utf8")
        .split("\n")
        .some((line) => / $/.test(line))
    ).toBe(false);
  });

  it("should return the same cached array when the shipped file is loaded twice", () => {
    // Act
    const first = loadPatterns();
    const second = loadPatterns();

    // Assert
    expect(second).toBe(first);
  });

  it("should fail closed when the pattern file holds nothing but comments and blank lines", () => {
    // Arrange
    const file = patternFile("# only a comment\n\n");

    // Act & Assert
    expect(() => loadPatterns(file)).toThrow(`no secret patterns in ${file}`);
  });

  it("should fail closed when the pattern file is missing", () => {
    // Arrange
    const file = path.join(os.tmpdir(), "agent-hub-no-such-patterns");

    // Act & Assert
    expect(() => loadPatterns(file)).toThrow(/ENOENT/);
  });

  it("should read a file given to it rather than the shipped one when a path is passed", () => {
    // Arrange
    const file = patternFile("# a comment\n\nONLY-THIS\n");

    // Act
    const patterns = loadPatterns(file);

    // Assert
    expect(patterns.map((p) => p.source)).toEqual(["ONLY-THIS"]);
  });
});

describe("parsePatterns", () => {
  it("should drop comments and blank lines and compile the rest when given a pattern list", () => {
    // Act
    const patterns = parsePatterns("# comment\n\nfoo[0-9]+\n#another\nbar\n");

    // Assert
    expect(patterns.map((p) => p.source)).toEqual(["foo[0-9]+", "bar"]);
    expect(patterns[0]?.test("foo12")).toBe(true);
  });
});

describe("findSecret", () => {
  for (const [name, secret] of Object.entries(fakeSecrets)) {
    it(`should name the pattern that matched when the text holds a ${name}`, () => {
      // Arrange
      const text = `some prose\n${secret}\nmore prose`;

      // Act
      const found = findSecret(text);

      // Assert
      expect(found).toBeTruthy();
      expect(new RegExp(found as string).test(text)).toBe(true);
    });
  }

  for (const text of clean) {
    it(`should return null when the text is "${text}"`, () => {
      // Act & Assert
      expect(findSecret(text)).toBeNull();
    });
  }

  it("should return null when the text is empty or absent", () => {
    // Act & Assert
    expect(findSecret("")).toBeNull();
    expect(findSecret(null)).toBeNull();
    expect(findSecret(undefined)).toBeNull();
  });

  it("should use the patterns it is given rather than the shipped ones when a list is passed", () => {
    // Act & Assert
    expect(findSecret("nothing to see here", [/to see/])).toBe("to see");
    expect(findSecret(fakeSecrets.githubToken, [/never-matches/])).toBeNull();
  });
});

describe("containsSecret", () => {
  it("should be true when the text holds a secret and false when it does not", () => {
    // Act & Assert
    expect(containsSecret(fakeSecrets.privateKey)).toBe(true);
    expect(containsSecret("nothing to see here")).toBe(false);
    expect(containsSecret("nothing to see here", [/to see/])).toBe(true);
  });
});
