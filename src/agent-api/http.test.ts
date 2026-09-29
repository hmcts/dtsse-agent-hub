import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MAX_BODY } from "../messages/limits.ts";
import { errorResponse, HttpError, json, MAX_REQUEST_BYTES, noContent, parse, parseLimit, parseMessageId, readJson } from "./http.ts";
import { cursorBody, directBody, heartbeatBody, MAX_REQUEST_TOPICS, postBody, registerBody, topicsBody } from "./schemas.ts";

function request(body: string): Request {
  return new Request("https://agent-hub.example/api/agent/register", { method: "POST", body });
}

describe("errorResponse", () => {
  it("should answer with the contract's error body and any extras", async () => {
    const response = errorResponse(409, "ambiguous", { candidates: [] });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "ambiguous", candidates: [] });
  });

  it("should not let an extra overwrite the error message", async () => {
    expect(await errorResponse(400, "real", { error: "forged" }).json()).toEqual({ error: "real" });
  });
});

describe("json and noContent", () => {
  it("should send JSON with the given status", async () => {
    const response = json({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("should send an empty 204", async () => {
    const response = noContent();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });
});

describe("readJson", () => {
  it("should read a JSON body", async () => {
    expect(await readJson(request('{"a":1}'))).toEqual({ a: 1 });
  });

  it("should read an empty body as an empty object, so a body-less POST is not a parse error", async () => {
    expect(await readJson(request(""))).toEqual({});
  });

  it("should refuse a body that is not JSON with a 400", async () => {
    await expect(readJson(request("{"))).rejects.toMatchObject({ status: 400 });
  });

  it("should refuse with a 413 when the declared content length is over the cap", async () => {
    const small = new Request("https://agent-hub.example/api/agent/register", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_REQUEST_BYTES + 1) }
    });

    await expect(readJson(small)).rejects.toMatchObject({ status: 413 });
  });

  it("should refuse with a 413 when a chunked body with no content length grows past the cap", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        controller.enqueue(chunk);
        if (sent > 8) {
          controller.close();
        }
      }
    });
    const chunked = new Request("https://agent-hub.example/api/agent/register", { method: "POST", body: stream, duplex: "half" } as RequestInit);

    expect(chunked.headers.get("content-length")).toBeNull();
    await expect(readJson(chunked)).rejects.toMatchObject({ status: 413 });
    expect(sent).toBeLessThan(9);
  });

  it("should accept a maximal message body written entirely as escaped multibyte text when it is under the cap", async () => {
    const text = "é".repeat(MAX_BODY);
    const escaped = JSON.stringify({ topics: ["a"], body: text }).replaceAll("é", "\\u00e9");

    expect(new TextEncoder().encode(escaped).byteLength).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(await readJson(request(escaped))).toEqual({ topics: ["a"], body: text });
  });

  it("should decode multibyte characters split across chunks when the body is streamed", async () => {
    const bytes = new TextEncoder().encode('{"body":"€"}');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 11));
        controller.enqueue(bytes.slice(11));
        controller.close();
      }
    });
    const split = new Request("https://agent-hub.example/api/agent/register", { method: "POST", body: stream, duplex: "half" } as RequestInit);

    expect(await readJson(split)).toEqual({ body: "€" });
  });

  it("should read an empty object when the request has no body", async () => {
    expect(await readJson(new Request("https://agent-hub.example/api/agent/register", { method: "POST" }))).toEqual({});
  });
});

describe("parse", () => {
  it("should name the field of the first issue", () => {
    expect(() => parse(z.object({ name: z.string() }), { name: 1 })).toThrow(/^name: /);
  });

  it("should report an issue on the whole value without a field name", () => {
    expect(() => parse(z.string(), 1)).toThrow(HttpError);
  });
});

describe("parseMessageId", () => {
  it("should read a decimal id beyond 2^53 exactly", () => {
    expect(parseMessageId("9007199254740993")).toBe(9_007_199_254_740_993n);
  });

  it.each([
    ["nothing", null],
    ["undefined", undefined],
    ["a negative number", "-1"],
    ["a decimal", "1.5"],
    ["hex", "0x10"],
    ["too many digits", "12345678901234567890"],
    ["beyond bigint", "9999999999999999999"]
  ])("should refuse %s with a 400", (_label, value) => {
    expect(() => parseMessageId(value, "since")).toThrow(HttpError);
  });
});

describe("parseLimit", () => {
  it("should default when absent", () => {
    expect(parseLimit(null, 50, 200)).toBe(50);
    expect(parseLimit("", 50, 200)).toBe(50);
  });

  it("should accept the maximum", () => {
    expect(parseLimit("200", 50, 200)).toBe(200);
  });

  it.each(["0", "201", "ten", "-5", "1.5"])("should refuse %s", (value) => {
    expect(() => parseLimit(value, 50, 200)).toThrow(HttpError);
  });
});

describe("registerBody", () => {
  it("should treat blank optional metadata as absent", () => {
    expect(parse(registerBody, { session_id: "s", name: "n", cwd: "  ", repo: null })).toEqual({
      session_id: "s",
      name: "n",
      cwd: null,
      repo: null,
      branch: null,
      host: null
    });
  });

  it("should require a session id and a name", () => {
    expect(() => parse(registerBody, { name: "n" })).toThrow(/session_id/);
    expect(() => parse(registerBody, { session_id: "s", name: " " })).toThrow(/name/);
  });
});

describe("heartbeatBody", () => {
  it("should refuse offline, which has an endpoint of its own", () => {
    expect(() => parse(heartbeatBody, { status: "offline" })).toThrow(/status/);
  });
});

describe("cursorBody", () => {
  it.each([["1234"], [1234]])("should accept the cursor %j as a bigint", (cursor) => {
    expect(parse(cursorBody, { cursor }).cursor).toBe(1234n);
  });

  it("should refuse a negative cursor", () => {
    expect(() => parse(cursorBody, { cursor: -1 })).toThrow(/cursor/);
  });

  it("should refuse a cursor when it is past the bigint range", () => {
    expect(() => parse(cursorBody, { cursor: "9223372036854775808" })).toThrow(/cursor/);
  });
});

describe("postBody", () => {
  it("should refuse a blank body", () => {
    expect(() => parse(postBody, { topics: ["a"], body: "   " })).toThrow(/body/);
  });

  it("should read in_reply_to as a bigint", () => {
    expect(parse(postBody, { topics: ["a"], body: "b", in_reply_to: "5" }).in_reply_to).toBe(5n);
  });

  it("should refuse in_reply_to when it is past the bigint range", () => {
    expect(() => parse(postBody, { topics: ["a"], body: "b", in_reply_to: "9223372036854775808" })).toThrow(/in_reply_to/);
  });

  it("should refuse the topics when there are more raw entries than the cap, even if they would de-duplicate", () => {
    expect(() => parse(postBody, { topics: Array.from({ length: MAX_REQUEST_TOPICS + 1 }, () => "a"), body: "b" })).toThrow(/topics/);
  });
});

describe("directBody", () => {
  it("should accept to_agent or reply_to_message", () => {
    expect(parse(directBody, { to_agent: "bob", body: "hi" }).to_agent).toBe("bob");
    expect(parse(directBody, { reply_to_message: "7", body: "hi" }).reply_to_message).toBe(7n);
  });

  it.each([
    ["neither", { body: "hi" }],
    ["both", { to_agent: "bob", reply_to_message: "7", body: "hi" }]
  ])("should refuse %s", (_label, body) => {
    expect(() => parse(directBody, body)).toThrow(/exactly one/);
  });
});

describe("topicsBody", () => {
  it("should accept the topics when there are exactly the maximum", () => {
    expect(parse(topicsBody, { topics: Array.from({ length: MAX_REQUEST_TOPICS }, (_, i) => `t${i}`) }).topics).toHaveLength(MAX_REQUEST_TOPICS);
  });

  it("should refuse with a message naming the field when there are more topics than the cap", () => {
    const topics = Array.from({ length: MAX_REQUEST_TOPICS + 1 }, (_, i) => `t${i}`);

    expect(() => parse(topicsBody, { topics })).toThrow(/^topics: at most 100 topics per request$/);
  });
});
