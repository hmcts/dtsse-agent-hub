/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MessageBody } from "@/components/feed/MessageBody";
import { MAX_BODY } from "@/messages/limits";

afterEach(cleanup);

function renderBody(body: string): HTMLElement {
  return render(<MessageBody body={body} />).container;
}

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("MessageBody", () => {
  it("should render plain text in one paragraph with its line breaks when it has no markup", () => {
    const container = renderBody("first line\nsecond line");

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]!.textContent).toBe("first line\nsecond line");
    expect(container.firstElementChild!.className).toContain("whitespace-pre-wrap");
  });

  it("should render HTML in a body as text when it contains tags", () => {
    const container = renderBody('<img src=x onerror="alert(1)"> <script>alert(1)</script>');

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
  });

  it("should open allowed links in a new tab without an opener when a body has URLs", () => {
    renderBody("see https://example.com/pr/1 and [the docs](https://example.com/docs) or [mail](mailto:a@example.com)");

    const pr = screen.getByRole("link", { name: "https://example.com/pr/1" });
    expect(pr.getAttribute("href")).toBe("https://example.com/pr/1");
    expect(pr.getAttribute("target")).toBe("_blank");
    expect(pr.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("link", { name: "the docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByRole("link", { name: "mail" }).getAttribute("href")).toBe("mailto:a@example.com");
  });

  it("should render no link when the scheme is not allowed", () => {
    const container = renderBody("[click](javascript:alert(1)) [data](data:text/html,x)");

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("[click](javascript:alert(1)) [data](data:text/html,x)");
  });

  it("should render inline code, bold and italics when a body uses them", () => {
    const container = renderBody("run `yarn test` **now** and _then_ *rest*");

    expect(container.querySelector("code")!.textContent).toBe("yarn test");
    expect(container.querySelector("strong")!.textContent).toBe("now");
    expect([...container.querySelectorAll("em")].map((node) => node.textContent)).toEqual(["then", "rest"]);
  });

  it("should render a focusable, scrollable code block with its language when a body has a fence", () => {
    const container = renderBody("```ts\nconst a = 1;\n```");

    const pre = container.querySelector("pre")!;
    expect(pre.tabIndex).toBe(0);
    expect(pre.className).toContain("overflow-x-auto");
    expect(pre.querySelector("code")!.textContent).toBe("const a = 1;");
    expect(pre.querySelector("code")!.dataset.language).toBe("ts");
    expect(container.textContent).toContain("ts");
  });

  it("should render a code block without a language label when the fence has none", () => {
    const container = renderBody("```\nplain\n```");

    expect(container.querySelector("code")!.hasAttribute("data-language")).toBe(false);
    expect(container.textContent).toBe("plain");
  });

  it("should render headings as bold paragraphs rather than heading elements", () => {
    const container = renderBody("# Summary\n## Details");

    expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    const paragraphs = [...container.querySelectorAll("p")];
    expect(paragraphs.map((node) => node.textContent)).toEqual(["Summary", "Details"]);
    expect(paragraphs[0]!.className).toContain("font-bold");
  });

  it("should render a focusable, scrollable table with aligned column headers when a body has a pipe table", () => {
    const container = renderBody("| left | centre | right |\n| :--- | :----: | -----: |\n| a | b | c |\n| d |");

    const node = container.querySelector("table")!;
    expect(node.parentElement!.tabIndex).toBe(0);
    expect(node.parentElement!.className).toContain("overflow-x-auto");
    const headers = [...node.querySelectorAll("thead th")];
    expect(headers.map((header) => header.textContent)).toEqual(["left", "centre", "right"]);
    expect(headers.map((header) => header.getAttribute("scope"))).toEqual(["col", "col", "col"]);
    expect(headers.map((header) => header.className.match(/text-(?:left|center|right)/)![0])).toEqual(["text-left", "text-center", "text-right"]);
    const rows = [...node.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["d", "", ""]
    ]);
  });

  it("should render a cell's own markup when a table cell holds a link or bold text", () => {
    const container = renderBody("| a | b |\n| - | - |\n| [docs](https://example.com/docs) | **bold** |");

    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(container.querySelector("td strong")!.textContent).toBe("bold");
  });

  it("should keep a code span's own spacing when it sits in a table cell", () => {
    const container = renderBody("| cmd |\n| --- |\n| `git log  --oneline` |");

    const span = container.querySelector("td code")!;
    expect(span.textContent).toBe("git log  --oneline");
    // No stylesheet runs here, so the classes are what carry it: the cell's text collapses its pipe padding, the span does not.
    expect(span.className).toContain("whitespace-pre-wrap");
    expect(container.querySelector("table")!.className).toContain("whitespace-normal");
  });

  it("should render no table when the delimiter row is missing", () => {
    const container = renderBody("| a | b |\n| c | d |");

    expect(container.querySelector("table")).toBeNull();
    expect(container.textContent).toBe("| a | b |\n| c | d |");
  });

  it("should render bullet and numbered lists with nesting and the start number", () => {
    const container = renderBody("3. three\n   - nested\n4. four\n\n- bullet");

    const ordered = container.querySelector("ol")!;
    expect(ordered.getAttribute("start")).toBe("3");
    expect(ordered.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(ordered.querySelector("li ul li")!.textContent).toBe("nested");
    expect(container.querySelectorAll(":scope > div > ul > li")).toHaveLength(1);
  });
});

/**
 * A body is rendered on the server for a topic's first payload and again on the client, for every viewer, every load,
 * so what a body costs to render matters as much as what it costs to parse. Table rows are padded to the header's
 * width, which is the one place in the subset where a short body can multiply into a large tree, so these measure the
 * markup and not just the time: a parse-time budget alone passed while a 32KB body rendered 68MB of HTML.
 */
describe("MessageBody on hostile bodies", () => {
  // A header of 64 columns, the widest a table opens with, and its delimiter row.
  const wide = `${"|h".repeat(64)}\n${"|-".repeat(64)}\n`;
  const hostile: Record<string, string> = {
    "a wide header over rows of one empty cell": `${wide}${"|\n".repeat((MAX_BODY - wide.length) / 2)}`,
    "a wide header over rows of one cell": `${wide}${"|x|\n".repeat((MAX_BODY - wide.length) / 4)}`,
    "a run of wide tables": `${wide}${"|\n".repeat(63)}`.repeat(Math.floor(MAX_BODY / (wide.length + 126))),
    "rows with far more cells than there are columns": `| a | b |\n| - | - |\n${`${"|".repeat(399)}\n`.repeat(79)}`,
    "rows of two cells": `| a | b |\n| - | - |\n${"| 1 | 2 |\n".repeat((MAX_BODY - 20) / 10)}`
  };

  for (const [name, body] of Object.entries(hostile)) {
    it(`should render within the cost budget when given ${name}`, () => {
      let html = "";
      const elapsed = timed(() => {
        html = renderToStaticMarkup(<MessageBody body={body} />);
      });

      expect(html.length).toBeLessThan(1_000_000);
      expect(elapsed).toBeLessThan(500);
    });
  }

  it("should render a budget-filling table within the share of a page one body may take", () => {
    // 64 empty columns over the rows that spend the whole cell cap: the smallest body that reaches it, and so the most
    // a table's padding can cost whatever the body's size, since padding is the one thing here that renders cells the
    // body does not hold. A page renders up to `CONVERSATION_PAGE_SIZE` bodies and appends older pages to the same DOM,
    // so this is multiplied by a hundred before a viewer has scrolled.
    const html = renderToStaticMarkup(<MessageBody body={`${wide}${"|\n".repeat(63)}`} />);

    expect(html.length).toBeLessThan(100_000);
  });

  it("should be able to hold every hostile body in a message", () => {
    for (const body of Object.values(hostile)) {
      expect(body.length).toBeLessThanOrEqual(MAX_BODY);
    }
  });
});

describe("MessageBody message references", () => {
  it("should link a #id to its message page in the same tab when a body quotes one", () => {
    renderBody("see #1234 and `#99`");

    const reference = screen.getByRole("link", { name: "#1234" });
    expect(reference.getAttribute("href")).toBe("/m/1234");
    expect(reference.hasAttribute("target")).toBe(false);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });
});
