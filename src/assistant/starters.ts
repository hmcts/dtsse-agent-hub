/**
 * What an empty conversation offers: starter cards and saved templates, both of which fill the composer for the
 * person to complete rather than sending anything. A card's template is a handful of plain headings, because most
 * people using the Assistant are not technical and a long form is a reason not to start. Static for now; nothing here
 * is per person.
 */

export interface Starter {
  title: string;
  sub: string;
  /** What the card fills the box with. The ask is the first line, so a message sent half-filled still makes sense. */
  text: string;
}

export interface Template {
  name: string;
  text: string;
}

/** What the person is to replace: a `[placeholder]` or an ellipsis, in the texts here and in a person's own. */
const GAP = /\[[^\]\n]*\]|…/;

export const STARTERS: readonly Starter[] = [
  {
    title: "Create user story",
    sub: "With acceptance criteria",
    text: "Help me write a user story with acceptance criteria.\n\nAs a: …\nI want to: …\nSo that: …\nAnything it must or must not do: …"
  },
  {
    title: "Research",
    sub: "Plan sessions and discussion guides",
    text: "Help me plan some user research.\n\nWhat I want to find out: …\nWho I want to speak to: …\nQuestions I already have: …\nWhat I need: …"
  },
  {
    title: "Analysis",
    sub: "Find themes in notes or feedback",
    text: "Help me find themes, pain points and opportunities.\n\nWhat I have: …\nWhat it is about: …\nWhat I want to get out of it: …"
  },
  {
    title: "Prototype",
    sub: "Outline screens and flows to test",
    text: "Help me plan a prototype to test.\n\nThe problem it solves: …\nWho will use it: …\nScreens or steps I have in mind: …\nWhat I want to learn from testing it: …"
  }
];

export const TEMPLATES: readonly Template[] = [
  {
    name: "New feature",
    text: "New feature: [title]\n\nAs a [user]\nI want [capability]\nSo that [benefit]\n\nAcceptance criteria:\n1. Given … when … then …"
  },
  {
    name: "Enhancement",
    text: "Enhancement: [title]\n\nCurrent behaviour: …\nProposed change: …\nWhy it matters: …\n\nAcceptance criteria:\n1. …"
  },
  { name: "Bug", text: "Bug: [title]\n\nSteps to reproduce:\n1. …\n\nExpected: …\nActual: …\nEnvironment: …\nSeverity: …" },
  { name: "Spike", text: "Spike: [title]\n\nQuestion to answer: …\nTimebox: …\nOutputs: …\nOut of scope: …" },
  { name: "Technical task", text: "Technical task: [title]\n\nContext: …\nWhat needs doing: …\nDependencies: …\nDefinition of done: …" }
];

/** What the box holds once a template is put in it, and the part of that to select so typing replaces it. */
export interface Filled {
  text: string;
  select: readonly [number, number];
}

/**
 * Puts `template` in a box holding `current`. It replaces the box when that holds nothing of the person's own — it is
 * blank, or is exactly one of `untouched`, a template nobody has changed — so going from one card to another swaps
 * them. Anything else is the person's words, and is kept above the template rather than lost to a click on a card.
 *
 * The template's first gap is selected, so the person can type the first answer straight away; with no gap the caret
 * goes to the end.
 */
export function fillWith(current: string, template: string, untouched: readonly string[]): Filled {
  const kept = current.trim() === "" || untouched.includes(current) ? "" : `${current.trimEnd()}\n\n`;
  const text = `${kept}${template}`;
  const gap = GAP.exec(template);
  if (gap === null) {
    return { text, select: [text.length, text.length] };
  }
  const at = kept.length + gap.index;
  return { text, select: [at, at + gap[0].length] };
}
