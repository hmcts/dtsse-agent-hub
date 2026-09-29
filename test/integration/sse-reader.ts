export interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** Reads SSE frames from a response body as they arrive. */
export function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const received: Frame[] = [];
  let buffer = "";

  async function pump(): Promise<boolean> {
    const { done, value } = await reader.read();
    if (done) {
      return false;
    }
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame: Frame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(": ")) {
          frame.comment = line.slice(2);
        } else {
          const [field, ...rest] = line.split(": ");
          const value = rest.join(": ");
          if (field === "id" || field === "event") {
            frame[field] = value;
          } else if (field === "data") {
            frame.data = frame.data === undefined ? value : `${frame.data}\n${value}`;
          }
        }
      }
      received.push(frame);
      end = buffer.indexOf("\n\n");
    }
    return true;
  }

  return {
    received,
    /** Resolves with every `direct` event once there are `count` of them. */
    async directs(count: number, timeoutMs = 5000): Promise<{ id: string; message: any }[]> {
      const deadline = Date.now() + timeoutMs;
      const directs = () => received.filter((frame) => frame.event === "direct");
      while (directs().length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} direct events, got ${directs().length}`);
        }
        const more = await Promise.race([pump(), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100))]);
        if (!more) {
          break;
        }
      }
      return directs().map((frame) => ({ id: frame.id!, message: JSON.parse(frame.data!).message }));
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    }
  };
}
