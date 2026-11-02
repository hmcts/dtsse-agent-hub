import { describe, expect, it } from "vitest";
import { isStartingError } from "./migrate.ts";

function withCode(code: string, message = "connect failed"): Error {
  return Object.assign(new Error(message), { code });
}

describe("isStartingError", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"])("should retry when the socket fails with %s", (code) => {
    expect(isStartingError(withCode(code))).toBe(true);
  });

  it("should retry when Postgres answers cannot_connect_now while it starts up", () => {
    expect(isStartingError(withCode("57P03", "the database system is starting up"))).toBe(true);
  });

  it("should retry when the server closes the connection mid-handshake", () => {
    expect(isStartingError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it.each([
    ["3D000", 'database "nope" does not exist'],
    ["28P01", 'password authentication failed for user "hmcts"'],
    ["28000", "no pg_hba.conf entry for host"]
  ])("should not retry when Postgres answers with %s", (code, message) => {
    expect(isStartingError(withCode(code, message))).toBe(false);
  });

  it("should not retry when the error has neither a known code nor the termination message", () => {
    expect(isStartingError(new Error("self-signed certificate in certificate chain"))).toBe(false);
  });

  it.each([undefined, null, "ECONNREFUSED", 42])("should not retry when the thrown value is %s", (value) => {
    expect(isStartingError(value)).toBe(false);
  });
});
