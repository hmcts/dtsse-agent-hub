import { describe, expect, it } from "vitest";
import { createSseParser, type SseEvent } from "./sse.ts";

function collect() {
  const events: SseEvent[] = [];
  const comments: string[] = [];
  const parser = createSseParser({ onEvent: (e) => events.push(e), onComment: (c) => comments.push(c) });
  return { parser, events, comments };
}

describe("createSseParser", () => {
  it("should report the id, event and data and the comments when a whole stream arrives at once", () => {
    // Arrange
    const { parser, events, comments } = collect();

    // Act
    parser.push('id: 1234\nevent: direct\ndata: {"message":{"id":"1234"}}\n\n: ping\n\n');

    // Assert
    expect(events).toEqual([{ id: "1234", event: "direct", data: '{"message":{"id":"1234"}}' }]);
    expect(comments).toEqual(["ping"]);
    expect(parser.lastEventId).toBe("1234");
  });

  it("should reassemble the event when the chunks split mid-line and mid-CRLF", () => {
    // Arrange
    const { parser, events } = collect();

    // Act
    for (const chunk of ["id: 7\r", "\nevent: dir", "ect\r\nda", "ta: a\r\ndata: b\r", "\n\r", "\n"]) {
      parser.push(chunk);
    }

    // Assert
    expect(events).toEqual([{ id: "7", event: "direct", data: "a\nb" }]);
  });

  it("should split on bare CR and default the event type when none is given", () => {
    // Arrange
    const { parser, events } = collect();

    // Act
    parser.push("data: x\r\rdata:y\n\n");

    // Assert
    expect(events.map((e) => [e.event, e.data])).toEqual([
      ["message", "x"],
      ["message", "y"]
    ]);
  });

  it("should dispatch nothing and reset the event type when a block has no data", () => {
    // Arrange
    const { parser, events } = collect();

    // Act
    parser.push("event: direct\n\ndata: z\n\n");

    // Assert
    expect(events).toEqual([{ id: "", event: "message", data: "z" }]);
  });

  it("should keep the id across events until one changes it", () => {
    // Arrange
    const { parser, events } = collect();

    // Act
    parser.push("id: 1\ndata: a\n\ndata: b\n\n");

    // Assert
    expect(events.map((e) => e.id)).toEqual(["1", "1"]);
  });

  it("should ignore a retry field and dispatch the reconnect event by name when the stream ends", () => {
    // Arrange
    const { parser, events, comments } = collect();

    // Act
    parser.push(": connected\n\nretry: 1000\n\nevent: reconnect\ndata: {}\n\n");

    // Assert
    expect(comments).toEqual(["connected"]);
    expect(events).toEqual([{ id: "", event: "reconnect", data: "{}" }]);
  });

  it("should ignore an id holding a NUL and keep a field with no colon when the line is malformed", () => {
    // Arrange
    const { parser, events } = collect();

    // Act
    parser.push("id: good\ndata: a\n\nid: ba\0d\ndata\ndata: b\n\n");

    // Assert
    expect(events).toEqual([
      { id: "good", event: "message", data: "a" },
      { id: "good", event: "message", data: "\nb" }
    ]);
  });

  it("should swallow comments when no onComment is given", () => {
    // Arrange
    const events: SseEvent[] = [];
    const parser = createSseParser({ onEvent: (e) => events.push(e) });

    // Act
    parser.push(": ping\n\ndata: a\n\n");

    // Assert
    expect(events).toEqual([{ id: "", event: "message", data: "a" }]);
  });
});
