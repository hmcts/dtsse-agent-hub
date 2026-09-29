import { describe, expect, it } from "vitest";
import { z } from "zod";
import { errorResponse, HttpError, json, noContent, parse, parseLimit, parseMessageId, readJson } from "./http.ts";
import { cursorBody, directBody, heartbeatBody, postBody, registerBody } from "./schemas.ts";

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
});

describe("postBody", () => {
  it("should refuse a blank body", () => {
    expect(() => parse(postBody, { topics: ["a"], body: "   " })).toThrow(/body/);
  });

  it("should read in_reply_to as a bigint", () => {
    expect(parse(postBody, { topics: ["a"], body: "b", in_reply_to: "5" }).in_reply_to).toBe(5n);
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
