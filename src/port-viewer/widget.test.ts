import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { escapeAttribute, readWidget, widgetSnippet } from "./widget.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("escapeAttribute", () => {
  it("should escape every character that could end an attribute or start markup", () => {
    expect(escapeAttribute(`a&b"c'd<e>f`)).toBe("a&amp;b&quot;c&#39;d&lt;e&gt;f");
  });
});

describe("widgetSnippet", () => {
  it("should give a deferred script from the widget's path carrying the page's settings", () => {
    expect(
      widgetSnippet({
        hubOrigin: "https://agent-hub.example",
        prefix: "/f/token",
        upstreamOrigin: "https://prototype.example",
        maskInputs: true,
        prototypeVersion: "1.2",
        nonce: "n0nce"
      })
    ).toBe(
      '<script src="/_feedback/widget.js" nonce="n0nce" data-hub-origin="https://agent-hub.example" data-prefix="/f/token" data-upstream-origin="https://prototype.example" data-mask-inputs="true" data-version="1.2" defer></script>'
    );
  });

  it("should escape every value and give an empty version when there is none", () => {
    const snippet = widgetSnippet({
      hubOrigin: "https://agent-hub.example",
      prefix: "/f/token",
      upstreamOrigin: 'https://x.example/"><script>',
      maskInputs: false,
      prototypeVersion: null,
      nonce: "n"
    });

    expect(snippet).toContain('data-upstream-origin="https://x.example/&quot;&gt;&lt;script&gt;"');
    expect(snippet).toContain('data-mask-inputs="false" data-version=""');
  });
});

describe("readWidget", () => {
  it("should read the built bundle from public/ under the root, with a digest for its ETag", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "widget-"));
    roots.push(root);
    await mkdir(path.join(root, "public", "feedback"), { recursive: true });
    await writeFile(path.join(root, "public", "feedback", "widget.js"), "console.log(1);");

    const widget = await readWidget(root);

    expect(new TextDecoder().decode(widget?.body)).toBe("console.log(1);");
    expect(widget?.etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it("should give nothing before the bundle is built", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "widget-"));
    roots.push(root);

    expect(await readWidget(root)).toBeUndefined();
  });
});
