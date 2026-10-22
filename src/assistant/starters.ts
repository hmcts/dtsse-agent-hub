/**
 * What an empty conversation offers: starter cards, each of which sends its prompt as the first message, and saved
 * templates, which fill the composer for the person to complete. Static for now; nothing here is per person.
 */

export interface Starter {
  title: string;
  sub: string;
  prompt: string;
}

export interface Template {
  name: string;
  text: string;
}

export const STARTERS: readonly Starter[] = [
  {
    title: "Create user story",
    sub: "With acceptance criteria",
    prompt: "Help me write a user story with acceptance criteria."
  },
  {
    title: "Research",
    sub: "Plan sessions and discussion guides",
    prompt: "Help me plan some user research: research questions, a recruitment screener and a discussion guide."
  },
  {
    title: "Analysis",
    sub: "Find themes in notes or feedback",
    prompt: "Help me find themes, pain points and opportunities in some research notes or feedback."
  },
  {
    title: "Prototype",
    sub: "Outline screens and flows to test",
    prompt: "Help me scope a prototype: the screens, the content on each and what to learn from testing it."
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
