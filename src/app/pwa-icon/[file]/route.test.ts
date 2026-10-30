import { describe, expect, it } from "vitest";
import { GET } from "./route.ts";

const ask = (file: string) => GET(new Request(`http://localhost/pwa-icon/${file}`), { params: Promise.resolve({ file }) });

describe("the installed app's icons", () => {
  it.each(["192.png", "512.png", "maskable-512.png", "180.png"])("should serve %s as a PNG", async (file) => {
    const response = await ask(file);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await response.arrayBuffer()).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it.each(["nope.png", "../icons.ts", "constructor", "__proto__"])("should answer 404 for %s", async (file) => {
    expect((await ask(file)).status).toBe(404);
  });
});
