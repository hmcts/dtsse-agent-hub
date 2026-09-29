import { describe, expect, it } from "vitest";
import { type Block, type Inline, parseInline, parseMarkup, safeHref } from "./markup.ts";

const text = (value: string): Inline => ({ type: "text", text: value });
const code = (value: string): Inline => ({ type: "code", text: value });
const strong = (...children: Inline[]): Inline => ({ type: "strong", children });
const em = (...children: Inline[]): Inline => ({ type: "emphasis", children });
const link = (href: string, ...children: Inline[]): Inline => ({ type: "link", href, children });
const ref = (id: string): Inline => ({ type: "message", id });
const paragraph = (...children: Inline[]): Block => ({ type: "paragraph", children });

function flatten(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      if (node.type === "message") {
        return `#${node.id}`;
      }
      return node.type === "text" || node.type === "code" ? node.text : flatten(node.children);
    })
    .join("");
}

function links(nodes: Inline[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === "link") {
      return [node.href, ...links(node.children)];
    }
    return node.type === "text" || node.type === "code" || node.type === "message" ? [] : links(node.children);
  });
}

function timed(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("safeHref", () => {
  it("should keep http, https and mailto URLs when they are absolute", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com/");
    expect(safeHref("http://example.com/a?b=c#d")).toBe("http://example.com/a?b=c#d");
    expect(safeHref("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(safeHref("HTTPS://EXAMPLE.COM/x")).toBe("https://example.com/x");
  });

  it("should reject a URL when its scheme is not allow-listed", () => {
    for (const raw of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "ftp://example.com"
    ]) {
      expect(safeHref(raw)).toBeNull();
    }
  });

  it("should reject a URL when it holds whitespace or control characters the URL parser would strip", () => {
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("https://exa mple.com")).toBeNull();
    expect(safeHref("\u0000https://example.com")).toBeNull();
    expect(safeHref("https://example.com\u007f")).toBeNull();
  });

  it("should reject a URL when it is relative or not a URL", () => {
    expect(safeHref("/topics/pcs-api")).toBeNull();
    expect(safeHref("example.com")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("parseInline", () => {
  it("should return the text alone when it has no markup", () => {
    expect(parseInline("hello world\nsecond line")).toEqual([text("hello world\nsecond line")]);
    expect(parseInline("")).toEqual([]);
  });

  it("should keep HTML as text when a body contains tags", () => {
    expect(parseInline('<script>alert(1)</script><img src=x onerror="alert(1)">')).toEqual([text('<script>alert(1)</script><img src=x onerror="alert(1)">')]);
  });

  it("should parse inline code and leave markers inside it alone when it is backticked", () => {
    expect(parseInline("run `yarn **test**` now")).toEqual([text("run "), code("yarn **test**"), text(" now")]);
    expect(parseInline("``a ` b``")).toEqual([code("a ` b")]);
    expect(parseInline("`` `x` ``")).toEqual([code("`x`")]);
    expect(parseInline("` `")).toEqual([code(" ")]);
  });

  it("should leave backticks as text when a code span is not closed", () => {
    expect(parseInline("a ` b `` c")).toEqual([text("a ` b `` c")]);
    expect(parseInline("``x` y`")).toEqual([text("``x"), code(" y")]);
  });

  it("should parse bold and italics when the markers sit at word boundaries", () => {
    expect(parseInline("a **bold** b")).toEqual([text("a "), strong(text("bold")), text(" b")]);
    expect(parseInline("an _italic_ word")).toEqual([text("an "), em(text("italic")), text(" word")]);
    expect(parseInline("an *italic* word")).toEqual([text("an "), em(text("italic")), text(" word")]);
    expect(parseInline("(**bold**), _it_.")).toEqual([text("("), strong(text("bold")), text("), "), em(text("it")), text(".")]);
  });

  it("should nest emphasis when bold and italics are combined", () => {
    expect(parseInline("**_both_**")).toEqual([strong(em(text("both")))]);
    expect(parseInline("_**both**_")).toEqual([em(strong(text("both")))]);
    expect(parseInline("***both***")).toEqual([strong(em(text("both")))]);
    expect(parseInline("**bold `code` and _it_**")).toEqual([strong(text("bold "), code("code"), text(" and "), em(text("it")))]);
  });

  it("should leave snake_case, paths and globs alone when underscores or stars are inside words", () => {
    for (const plain of [
      "snake_case_name",
      "__init__.py",
      "src/**/*.ts and src/**/x",
      "a*b*c",
      "2 * 3 * 4",
      "file_name_v2_final.txt",
      "/tmp/some_dir/other_file",
      "MAX_LINK_URL and MAX_INLINE_DEPTH",
      "foo**bar**baz"
    ]) {
      expect(flatten(parseInline(plain))).toBe(plain);
      expect(parseInline(plain)).toEqual([text(plain)]);
    }
  });

  it("should leave markers as text when they are unterminated or wrap whitespace", () => {
    for (const plain of ["**not closed", "_not closed", "*not closed", "** spaced **", "_ spaced _", "****", "__", "a **b", "*"]) {
      expect(parseInline(plain)).toEqual([text(plain)]);
    }
  });

  it("should keep crossed markers as text when they overlap rather than nest", () => {
    const nodes = parseInline("**a _b** c_");
    expect(flatten(nodes)).toBe("a _b c_");
    expect(nodes).toEqual([strong(text("a _b")), text(" c_")]);
  });

  it("should autolink http and https URLs and leave trailing punctuation outside the link", () => {
    expect(parseInline("see https://example.com/a_b_c.")).toEqual([
      text("see "),
      link("https://example.com/a_b_c", text("https://example.com/a_b_c")),
      text(".")
    ]);
    expect(parseInline("(http://example.com/x)")).toEqual([text("("), link("http://example.com/x", text("http://example.com/x")), text(")")]);
    expect(parseInline("https://en.wikipedia.org/wiki/A_(b)")).toEqual([
      link("https://en.wikipedia.org/wiki/A_(b)", text("https://en.wikipedia.org/wiki/A_(b)"))
    ]);
    expect(parseInline("<https://example.com>")).toEqual([text("<"), link("https://example.com/", text("https://example.com")), text(">")]);
  });

  it("should not autolink when the scheme has no host or is part of a word", () => {
    expect(parseInline("https:// alone")).toEqual([text("https:// alone")]);
    expect(parseInline("xhttps://example.com")).toEqual([text("xhttps://example.com")]);
    expect(parseInline("https://[bad")).toEqual([text("https://[bad")]);
    expect(parseInline("hello http")).toEqual([text("hello http")]);
  });

  it("should parse a markdown link when its scheme is allowed", () => {
    expect(parseInline("read [the docs](https://example.com/docs) now")).toEqual([
      text("read "),
      link("https://example.com/docs", text("the docs")),
      text(" now")
    ]);
    expect(parseInline("[mail me](mailto:a@example.com)")).toEqual([link("mailto:a@example.com", text("mail me"))]);
    expect(parseInline("[**bold** `code`](https://x.test)")).toEqual([link("https://x.test/", strong(text("bold")), text(" "), code("code"))]);
    expect(parseInline("[](https://x.test)")).toEqual([link("https://x.test/", text("https://x.test/"))]);
  });

  it("should not autolink inside a link's text when the text is itself a URL", () => {
    expect(parseInline("[https://a.test](https://b.test)")).toEqual([link("https://b.test/", text("https://a.test"))]);
  });

  it("should keep a markdown link as text when its scheme is not allowed", () => {
    for (const hostile of [
      "[click](javascript:alert(1))",
      "[click](JAVASCRIPT:alert(1))",
      "[click](data:text/html;base64,PHNjcmlwdD4=)",
      "[click](vbscript:x)",
      "[click](java\tscript:alert(1))",
      "[click](/relative/path)"
    ]) {
      const nodes = parseInline(hostile);
      expect(links(nodes)).toEqual([]);
      expect(flatten(nodes)).toBe(hostile);
    }
  });

  it("should keep brackets as text when they are not a link", () => {
    expect(parseInline("[not a link] (x)")).toEqual([text("[not a link] (x)")]);
    expect(parseInline("[unclosed](https://example.com")).toEqual([text("[unclosed]("), link("https://example.com/", text("https://example.com"))]);
    expect(parseInline("a [b")).toEqual([text("a [b")]);
  });

  it("should parse a message reference when #digits stands as a whole word", () => {
    expect(parseInline("see #1234")).toEqual([text("see "), ref("1234")]);
    expect(parseInline("#1 and #22, (#333). #4!")).toEqual([ref("1"), text(" and "), ref("22"), text(", ("), ref("333"), text("). "), ref("4"), text("!")]);
    expect(parseInline("**#5** _#6_")).toEqual([strong(ref("5")), text(" "), em(ref("6"))]);
    expect(parseInline("#9223372036854775807")).toEqual([ref("9223372036854775807")]);
    expect(parseInline("line\n#7")).toEqual([text("line\n"), ref("7")]);
  });

  it("should leave #digits as text when it is part of a word, zero-padded, out of range or not digits", () => {
    for (const plain of [
      "issue#12",
      "#12a",
      "#12_x",
      "&#12;",
      "path/#12",
      "#007",
      "#0",
      "#9223372036854775808",
      "#123456789012345678901234",
      "# 12",
      "#",
      "#abc",
      "C#1"
    ]) {
      expect(parseInline(plain)).toEqual([text(plain)]);
    }
  });

  it("should not parse a message reference when it sits inside code, a URL or a link's text", () => {
    expect(parseInline("`#12`")).toEqual([code("#12")]);
    expect(parseInline("https://example.com/page#12")).toEqual([link("https://example.com/page#12", text("https://example.com/page#12"))]);
    expect(parseInline("[#12](https://example.com)")).toEqual([link("https://example.com/", text("#12"))]);
  });

  it("should never produce a link to a disallowed scheme when given hostile inputs", () => {
    const hostile = [
      "[a](javascript:alert(1))[b](https://ok.test)",
      "[[x](javascript:1)](https://ok.test)",
      "**[x](javascript:1)**",
      "_[x](data:text/html,1)_",
      "`[x](https://ok.test)` [y](javascript:1)",
      "javascript:alert(1)",
      "https://ok.test/?q=javascript:alert(1)"
    ];
    for (const input of hostile) {
      for (const href of links(parseInline(input))) {
        expect(href).toMatch(/^(https?:\/\/|mailto:)/);
      }
    }
  });
});

describe("parseMarkup", () => {
  it("should split paragraphs on blank lines and keep line breaks inside them", () => {
    expect(parseMarkup("one\ntwo\n\n\nthree\r\nfour")).toEqual([paragraph(text("one\ntwo")), paragraph(text("three\nfour"))]);
    expect(parseMarkup("")).toEqual([]);
    expect(parseMarkup("  \n\t\n")).toEqual([]);
  });

  it("should parse a fenced code block with its language and keep markup inside it as text", () => {
    expect(parseMarkup("before\n```ts\nconst a = **b**;\n  indented <b>\n```\nafter")).toEqual([
      paragraph(text("before")),
      { type: "code", language: "ts", text: "const a = **b**;\n  indented <b>" },
      paragraph(text("after"))
    ]);
  });

  it("should leave the language empty when the fence has none or an odd one", () => {
    expect(parseMarkup("```\nx\n```")).toEqual([{ type: "code", language: null, text: "x" }]);
    expect(parseMarkup("```<script>\nx\n```")).toEqual([{ type: "code", language: null, text: "x" }]);
    expect(parseMarkup("```bash title=run\nx\n````")).toEqual([{ type: "code", language: "bash", text: "x" }]);
  });

  it("should run a code block to the end of the body when its fence is not closed", () => {
    expect(parseMarkup("```\nline one\n\nline two")).toEqual([{ type: "code", language: null, text: "line one\n\nline two" }]);
  });

  it("should strip the fence's indentation from its lines when the fence is indented", () => {
    expect(parseMarkup("1. Run:\n   ```bash\n   yarn test\n     --watch\n   ```")).toEqual([
      { type: "list", ordered: true, start: 1, items: [{ children: [text("Run:")], lists: [] }] },
      { type: "code", language: "bash", text: "yarn test\n  --watch" }
    ]);
  });

  it("should treat a line as inline code rather than a fence when its info string has a backtick", () => {
    expect(parseMarkup("```a``` b")).toEqual([paragraph(code("a"), text(" b"))]);
  });

  it("should parse headings and drop their closing hashes", () => {
    expect(parseMarkup("# Title\n## Sub **bold** ##\n### C#\n#### #")).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      { type: "heading", level: 2, children: [text("Sub "), strong(text("bold"))] },
      { type: "heading", level: 3, children: [text("C#")] },
      { type: "heading", level: 4, children: [] }
    ]);
  });

  it("should not parse a heading when the hashes are not followed by a space", () => {
    expect(parseMarkup("#123 is fixed\n####### seven")).toEqual([paragraph(ref("123"), text(" is fixed\n####### seven"))]);
  });

  it("should parse bullet and numbered lists and keep their start number", () => {
    expect(parseMarkup("- one\n* two\n+ **three**\n\n3. c\n4) d")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          { children: [text("one")], lists: [] },
          { children: [text("two")], lists: [] },
          { children: [strong(text("three"))], lists: [] }
        ]
      },
      {
        type: "list",
        ordered: true,
        start: 3,
        items: [
          { children: [text("c")], lists: [] },
          { children: [text("d")], lists: [] }
        ]
      }
    ]);
  });

  it("should nest a list under the previous item when it is indented", () => {
    expect(parseMarkup("1. one\n   - a\n   - b\n2. two\n    1. deep")).toEqual([
      {
        type: "list",
        ordered: true,
        start: 1,
        items: [
          {
            children: [text("one")],
            lists: [
              {
                type: "list",
                ordered: false,
                start: 1,
                items: [
                  { children: [text("a")], lists: [] },
                  { children: [text("b")], lists: [] }
                ]
              }
            ]
          },
          { children: [text("two")], lists: [{ type: "list", ordered: true, start: 1, items: [{ children: [text("deep")], lists: [] }] }] }
        ]
      }
    ]);
  });

  it("should start a sibling list when the marker kind changes at the same level", () => {
    const blocks = parseMarkup("- a\n1. b\n  - c\n  2. d");
    expect(blocks.map((block) => block.type === "list" && block.ordered)).toEqual([false, true]);
    const ordered = blocks[1] as Extract<Block, { type: "list" }>;
    expect(ordered.items[0]!.lists.map((list) => list.ordered)).toEqual([false, true]);
    expect(ordered.items[0]!.lists[1]!.start).toBe(2);
  });

  it("should count a tab as four spaces when a nested item is tab-indented", () => {
    const [list] = parseMarkup("- a\n\t- b") as Extract<Block, { type: "list" }>[];
    expect(list!.items[0]!.lists[0]!.items[0]!.children).toEqual([text("b")]);
  });

  it("should start a new top-level list when an item is less indented than the first", () => {
    const blocks = parseMarkup("  - a\n- b");
    expect(blocks).toHaveLength(2);
  });

  it("should append indented continuation lines to the item above them", () => {
    expect(parseMarkup("- first\n  more of it\n- second\nnot in the list")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          { children: [text("first\nmore of it")], lists: [] },
          { children: [text("second")], lists: [] }
        ]
      },
      paragraph(text("not in the list"))
    ]);
  });

  it("should keep one list across blank lines when the next line is another item", () => {
    const blocks = parseMarkup("- a\n\n- b\n\nafter");
    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
    expect((blocks[0] as Extract<Block, { type: "list" }>).items).toHaveLength(2);
  });

  it("should end a paragraph when a list, heading or fence starts", () => {
    expect(parseMarkup("intro\n- item\ntext\n# head\ntext\n```\ncode\n```").map((block) => block.type)).toEqual([
      "paragraph",
      "list",
      "paragraph",
      "heading",
      "paragraph",
      "code"
    ]);
  });

  it("should not treat a rule or bold line as a list item when there is no space after the marker", () => {
    expect(parseMarkup("---\n**bold** line\n-5 degrees")).toEqual([paragraph(text("---\n"), strong(text("bold")), text(" line\n-5 degrees"))]);
  });

  it("should cap list nesting when indentation keeps growing", () => {
    const body = Array.from({ length: 50 }, (_, depth) => `${" ".repeat(depth * 2)}- level ${depth}`).join("\n");
    let depth = 0;
    let lists = parseMarkup(body) as Extract<Block, { type: "list" }>[];
    while (lists.length > 0) {
      depth++;
      lists = lists[0]!.items.at(-1)!.lists;
    }
    expect(depth).toBe(4);
  });
});

describe("parseMarkup on hostile and huge inputs", () => {
  const LIMIT = 32_000;
  const cases: Record<string, string> = {
    "unmatched strong openers": "**a ".repeat(LIMIT / 4),
    "unmatched underscore openers": " _a".repeat(LIMIT / 3),
    "unmatched star openers": " *a".repeat(LIMIT / 3),
    "closers that never validate": "**a **a".repeat(LIMIT / 7),
    "open brackets": "[".repeat(LIMIT),
    "brackets sharing one close": `${"[".repeat(LIMIT - 1)}]`,
    "link openers sharing a distant paren": `${"[](".repeat(LIMIT / 3 - 1)})`,
    "rejected links": "[a](javascript:x) ".repeat(LIMIT / 18),
    "backtick runs of growing length": Array.from({ length: 250 }, (_, i) => "`".repeat(i + 1)).join(" "),
    "single backticks": "`".repeat(LIMIT),
    "alternating backticks": "` ``".repeat(LIMIT / 4),
    "url-like runs": "http://[".repeat(LIMIT / 8),
    "one enormous url": `https://example.com/${"a".repeat(LIMIT)}`,
    "spaces then a character": `${" ".repeat(LIMIT - 1)}x`,
    hashes: `# ${"#".repeat(LIMIT)} x`,
    "heading spaces": `# a${" ".repeat(LIMIT)}b`,
    "list markers": "- ".repeat(LIMIT / 2),
    "deep indentation": Array.from({ length: 2_000 }, (_, i) => `${" ".repeat(i % 200)}- x`).join("\n"),
    "fence openers": "```\n".repeat(LIMIT / 4),
    "blank lines between items": "- a\n\n\n".repeat(LIMIT / 7),
    "mixed markers": "*_`[**__``((]])".repeat(LIMIT / 15),
    "message references": "#1 ".repeat(LIMIT / 3),
    "long digit runs": `#${"9".repeat(LIMIT - 1)}`,
    "nested emphasis": "**_*".repeat(LIMIT / 8) + "*_**".repeat(LIMIT / 8)
  };

  for (const [name, body] of Object.entries(cases)) {
    it(`should parse within the time budget when given ${name}`, () => {
      const elapsed = timed(() => parseMarkup(body));
      expect(elapsed).toBeLessThan(500);
    });
  }

  it("should keep every character of a plain paragraph when the body is at the size limit", () => {
    const body = "word_with_underscores and *stars* ".repeat(LIMIT / 34);
    const [only] = parseMarkup(body.trim());
    expect(only?.type).toBe("paragraph");
    expect(flatten((only as Extract<Block, { type: "paragraph" }>).children)).toBe(body.trim().replaceAll("*stars*", "stars"));
  });
});
