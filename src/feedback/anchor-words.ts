import type { FeedbackAnchor } from "./schemas.ts";

/**
 * What a thread's element is, in the words a reviewer or a researcher would use: "the “Start now” button", "the text
 * “It takes around 20 minutes.”", rather than its tag name. Pure, so the review shell and the team's lists say the
 * same thing of the same element.
 */

/** The longest stretch of an element's text quoted, so a paragraph does not crowd out the comment it is beside. */
export const MAX_QUOTED = 60;

const NOUNS: Readonly<Record<string, string>> = {
  a: "link",
  button: "button",
  input: "field",
  select: "field",
  textarea: "field",
  option: "option",
  label: "label",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  img: "image",
  picture: "image",
  svg: "image",
  legend: "question",
  fieldset: "question",
  summary: "expandable section",
  details: "expandable section",
  table: "table",
  thead: "table",
  tbody: "table",
  tr: "table row",
  th: "table heading",
  td: "table cell",
  ul: "list",
  ol: "list",
  dl: "list",
  li: "list item",
  nav: "menu",
  form: "form",
  header: "page header",
  footer: "page footer"
};

/** The noun for `tag`; anything not named, from a `p` to a `div`, is the page's text. */
export function elementNoun(tag: string): string {
  return NOUNS[tag.toLowerCase()] ?? "text";
}

/** `text` with its whitespace run together and cut to `MAX_QUOTED` characters. */
export function quoted(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUOTED ? `${flat.slice(0, MAX_QUOTED).trimEnd()}…` : flat;
}

const article = (noun: string): string => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);

/** The element as a phrase that reads after "on": "the “Start now” link", "the text “…”", "an image". */
export function describeElement(anchor: Pick<FeedbackAnchor, "tag" | "text">): string {
  const noun = elementNoun(anchor.tag);
  const text = quoted(anchor.text);
  if (noun === "text") {
    return text === "" ? "part of the page" : `the text “${text}”`;
  }
  return text === "" ? article(noun) : `the “${text}” ${noun}`;
}
