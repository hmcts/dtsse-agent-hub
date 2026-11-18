/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { groupTemplates, jobFailure, lineDiff, type NotifyView, sanitiseHtml, showsNotifyPreview } from "./notify-data";

const view = (overrides: Partial<NotifyView> = {}): NotifyView => ({
  version: 1,
  revision: 0,
  product: "pcs",
  template_id: "t",
  service_id: "s",
  type: "email",
  name: "Claim",
  subject: "Claim ((ref))",
  body: "Dear ((name))",
  notify_version: 4,
  notify_subject: "Claim ((ref))",
  notify_body: "Dear ((name))",
  notify_preview: "<p>Dear ((name))</p>",
  data: {},
  by: "agent",
  summary: null,
  updated_at: "",
  ...overrides
});

describe("lineDiff", () => {
  it("should mark every line the same when nothing changed", () => {
    expect(lineDiff("a\nb", "a\nb")).toEqual([
      { kind: "same", text: "a" },
      { kind: "same", text: "b" }
    ]);
  });

  it("should mark lines removed and added around the ones kept", () => {
    expect(lineDiff("a\nb\nc", "a\nx\nc\nd")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" }
    ]);
    expect(lineDiff("a\nb", "b")).toEqual([
      { kind: "removed", text: "a" },
      { kind: "same", text: "b" }
    ]);
    expect(lineDiff("a\nb", "a")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" }
    ]);
  });

  it("should replace the whole text when the two are too long to compare line by line", () => {
    const before = Array.from({ length: 2001 }, (_, at) => `b${at}`).join("\n");
    const after = Array.from({ length: 2001 }, (_, at) => `a${at}`).join("\n");
    const lines = lineDiff(before, after);
    expect(lines).toHaveLength(4002);
    expect(lines[0]).toEqual({ kind: "removed", text: "b0" });
    expect(lines.at(-1)).toEqual({ kind: "added", text: "a2000" });
  });
});

describe("sanitiseHtml", () => {
  it("should drop what runs or loads code, and keep the markup and safe links", () => {
    const clean = sanitiseHtml(
      [
        '<p onclick="steal()" style="color: red">Hello <a href="https://gov.uk">GOV.UK</a> <a href="javascript:alert(1)">bad</a> <a href="#top">top</a> <a href="mailto:a@b.c">mail</a></p>',
        "<script>alert(1)</script><style>p{}</style><iframe src='https://x'></iframe><object></object><embed><form><input></form>",
        '<link rel="stylesheet" href="x"><meta http-equiv="refresh"><base href="https://evil">',
        '<img src="https://gov.uk/crown.png" srcset="x 1x" onerror="steal()"><img src="data:image/png;base64,AA"><div style="background: url(javascript:x)">d</div>'
      ].join("")
    );
    const parsed = new DOMParser().parseFromString(clean, "text/html");

    expect(parsed.querySelectorAll("script, style, iframe, object, embed, form, link, meta, base")).toHaveLength(0);
    expect(clean).not.toMatch(/onclick|onerror|javascript:|srcset|data:image/);
    const links = Array.from(parsed.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["https://gov.uk", null, "#top", "mailto:a@b.c"]);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.hasAttribute("target")).toBe(false);
    expect(parsed.querySelector("p")?.getAttribute("style")).toBe("color: red");
    expect(parsed.querySelector("div")?.hasAttribute("style")).toBe(false);
    expect(parsed.querySelector("img")?.getAttribute("src")).toBe("https://gov.uk/crown.png");
  });
});

describe("groupTemplates", () => {
  it("should group by type, emails first, each by name, and leave out empty groups", () => {
    const groups = groupTemplates([
      { id: "3", name: "Letter", type: "letter", version: 1 },
      { id: "2", name: "Zed", type: "email", version: 1 },
      { id: "1", name: "Alpha", type: "email", version: 1 },
      { id: "0", name: "Alpha", type: "email", version: 1 }
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Emails", "Letters"]);
    expect(groups[0]?.templates.map((each) => each.id)).toEqual(["0", "1", "2"]);
  });
});

describe("showsNotifyPreview", () => {
  it("should be Notify's own preview only while the draft is Notify's text with nothing filled in", () => {
    const shown = view();
    expect(showsNotifyPreview(shown, "Claim ((ref))", "Dear ((name))", {})).toBe(true);
    expect(showsNotifyPreview(shown, "Claim ((ref))", "Dear ((name))", { name: "Ada" })).toBe(false);
    expect(showsNotifyPreview(shown, "Claim", "Dear ((name))", {})).toBe(false);
    expect(showsNotifyPreview(shown, "Claim ((ref))", "Hi", {})).toBe(false);
    expect(showsNotifyPreview(view({ notify_preview: null }), "Claim ((ref))", "Dear ((name))", {})).toBe(false);
  });
});

describe("jobFailure", () => {
  it("should show the pod's own words first, then words for its code", () => {
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "failed", error: "forbidden", detail: "Forbidden: no access to pcs-aat." })).toBe(
      "Forbidden: no access to pcs-aat."
    );
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "failed", error: "az_login" })).toMatch(/not signed in to Azure/);
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "failed", error: "busy" })).toBe("That did not work. Try again.");
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "failed" })).toBe("That did not work. Try again.");
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "failed", error: "timeout" })).toBe("That took too long. Try again.");
    expect(jobFailure({ job_id: "j", kind: "notify.list", status: "timeout" })).toBe("That took too long. Try again.");
    expect(jobFailure({ job_id: "j", status: "missing" })).toMatch(/answer was lost/);
  });
});
