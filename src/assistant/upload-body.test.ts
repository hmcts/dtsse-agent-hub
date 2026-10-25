import { describe, expect, it } from "vitest";
import { HttpError } from "../agent-api/http.ts";
import { readBytes } from "./upload-body.ts";

/** A request whose body arrives as several chunks, as a real upload's does. */
function streamed(chunks: readonly Uint8Array[], headers: Record<string, string> = {}): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });
  return new Request("http://localhost/api/ui/uploads/u/parts/0", { method: "PUT", body, headers, duplex: "half" } as RequestInit);
}

function filled(length: number, value = 7): Uint8Array {
  return new Uint8Array(length).fill(value);
}

describe("readBytes", () => {
  it("should return the whole body when it is exactly the limit", async () => {
    // Arrange
    const request = streamed([filled(4, 1), filled(4, 2)]);

    // Act
    const bytes = await readBytes(request, 8);

    // Assert
    expect(bytes.byteLength).toBe(8);
    expect([...bytes]).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("should return a body shorter than the limit without its padding", async () => {
    // Arrange
    const request = streamed([filled(3, 5)]);

    // Act
    const bytes = await readBytes(request, 8);

    // Assert
    expect([...bytes]).toEqual([5, 5, 5]);
  });

  it("should refuse a body that runs past the limit when the length was not declared", async () => {
    // Arrange
    const request = streamed([filled(4), filled(5)]);

    // Act
    const refusal = await readBytes(request, 8).catch((error: unknown) => error);

    // Assert
    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).status).toBe(413);
  });

  it("should refuse on the declared length alone when that is already past the limit", async () => {
    // Arrange: a body that would fit, declared as one that would not, so only the header can be refusing it.
    const request = streamed([filled(2)], { "content-length": "99" });

    // Act
    const refusal = await readBytes(request, 8).catch((error: unknown) => error);

    // Assert
    expect((refusal as HttpError).status).toBe(413);
    expect((refusal as HttpError).message).toBe("this part of the file is larger than 8 bytes");
  });

  it("should return nothing for a request with no body", async () => {
    // Arrange
    const request = new Request("http://localhost/x", { method: "PUT" });

    // Act
    const bytes = await readBytes(request, 8);

    // Assert
    expect(bytes.byteLength).toBe(0);
  });
});
