import { describe, expect, it } from "vitest";
import { createLogger, describeError, oneLine, redacting, withoutSecrets } from "./log.ts";

const AT = new Date("2026-10-05T12:00:00Z");

function capture() {
  const lines: string[] = [];
  return {
    lines,
    log: createLogger(
      (line) => lines.push(line),
      () => AT
    )
  };
}

describe("createLogger", () => {
  it("should write one JSON object per call with the time, level and message", () => {
    const { lines, log } = capture();

    log("info", "applied", { id: "a", generation: 2 });

    expect(lines).toEqual([JSON.stringify({ id: "a", generation: 2, time: AT.toISOString(), level: "info", message: "applied" })]);
  });

  it("should remove line breaks from the message and from every string field, however deep, when they hold untrusted text", () => {
    const { lines, log } = capture();

    log("error", "could not\r\napply", { error: "bad\nline", nested: { list: ["a b"], "k\ne": 1 }, none: null });

    const [line] = lines;
    expect(line).not.toMatch(/\\[rn]|\\u2028/);
    expect(JSON.parse(line!)).toMatchObject({ message: "could not  apply", error: "bad line", nested: { list: ["a b"], "k e": 1 }, none: null });
  });

  it("should not let a field overwrite the time, level or message when it has the same name", () => {
    const { lines, log } = capture();

    log("warn", "pass", { level: "info", message: "forged", time: "then" });

    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", message: "pass", time: AT.toISOString() });
  });

  it("should default to no fields", () => {
    const { lines, log } = capture();

    log("info", "started");

    expect(JSON.parse(lines[0]!)).toEqual({ time: AT.toISOString(), level: "info", message: "started" });
  });

  it("should write to stdout on the system clock when given nothing", () => {
    const writes: string[] = [];
    const original = process.stdout.write;
    process.stdout.write = ((chunk: string) => writes.push(chunk) > 0) as typeof process.stdout.write;
    try {
      createLogger()("info", "hello");
    } finally {
      process.stdout.write = original;
    }

    expect(writes[0]).toMatch(/"message":"hello"\}\n$/);
  });
});

describe("describeError", () => {
  it.each([
    ["an Error", new Error("one\ntwo"), "one two"],
    ["a thrown string", "three\rfour", "three four"]
  ])("should give the message on one line when it is %s", (_label, error, expected) => {
    expect(describeError(error)).toBe(expected);
  });
});

describe("oneLine", () => {
  it("should leave text without line breaks alone", () => {
    expect(oneLine("plain")).toBe("plain");
  });
});

describe("withoutSecrets", () => {
  it("should replace every appearance of each secret when the text quotes them", () => {
    expect(withoutSecrets("apim-key sent twice: apim-key, and base-64", ["apim-key", "base-64"])).toBe("[redacted] sent twice: [redacted], and [redacted]");
  });

  it("should leave the text alone when it quotes no secret", () => {
    expect(withoutSecrets("StatefulSet is invalid", ["apim-key"])).toBe("StatefulSet is invalid");
  });

  // An empty string appears between every character, so redacting on one would take the whole line out.
  it("should leave the text alone when a secret is empty", () => {
    expect(withoutSecrets("plain", [""])).toBe("plain");
  });
});

describe("redacting", () => {
  function lines(secrets: string[]) {
    const written: string[] = [];
    return {
      log: redacting(
        createLogger(
          (line) => written.push(line),
          () => new Date(0)
        ),
        secrets
      ),
      written
    };
  }

  it("should take a secret out of the message and of every field, however deep, when a line quotes one", () => {
    const { log, written } = lines(["apim-key"]);

    log("error", "could not apply apim-key", { error: 'env[6].value: "apim-key"', env: [{ "apim-key": ["apim-key"] }] });

    expect(written[0]).toBe(
      '{"error":"env[6].value: \\"[redacted]\\"","env":[{"[redacted]":["[redacted]"]}],"time":"1970-01-01T00:00:00.000Z","level":"error","message":"could not apply [redacted]"}'
    );
  });

  it("should write what it was given when there is no secret to take out", () => {
    const { log, written } = lines([]);

    log("info", "applied", { id: "a" });

    expect(written[0]).toBe('{"id":"a","time":"1970-01-01T00:00:00.000Z","level":"info","message":"applied"}');
  });
});
