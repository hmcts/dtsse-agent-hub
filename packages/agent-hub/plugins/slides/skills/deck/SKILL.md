---
name: deck
description: Make an HMCTS-branded PowerPoint deck from an outline — title slide on the HMCTS artwork, navy title bars, section dividers, bullets, two columns, pictures with captions and a closing slide, all as real slide masters that stay editable in PowerPoint. Use when someone asks for "slides", "a deck", "a presentation", "a PowerPoint", "turn this into slides" or "slides for my show and tell".
---

# HMCTS slide decks

Drive `${CLAUDE_PLUGIN_ROOT}/scripts/slides`, written `slides` below. You write an outline as JSON; the script picks
the geometry, fonts and colours and writes the `.pptx`. Results are JSON on stdout; warnings and progress are on
stderr. Full guide: `${CLAUDE_PLUGIN_ROOT}/README.md`.

## The rule that overrides everything else

**You only pick layouts and write their fields.** Never place, size, colour or style anything, never add shapes,
text boxes or fonts, and never edit the `.pptx` afterwards, with pptxgenjs, python-pptx or by hand. Every slide is
one of the layouts `slides layouts` lists, filled through its placeholders, so the deck stays on-brand and editable.
If nothing fits, split the content across slides or say what layout is missing; don't improvise one.

## Before writing anything, ask

Ask the person, in one message:

1. **Who is the audience?** (their team, senior leaders, a service team, the public, …)
2. **What is it for?** (inform, decide, train, show and tell, …) and what should people do or know afterwards.
3. **Roughly how long?** Minutes or number of slides. As a guide, one slide for every one to two minutes.

Also ask for any pictures they want used, as files. Don't start the outline until you have the answers.

## Steps

1. `slides layouts` prints every layout with its fields and limits, as JSON. Read it each time rather than from
   memory: it is the only list of them, and it changes with the plugin.
2. Write the outline to a file beside any pictures it uses, such as `deck/outline.json`. Show the person the slide
   titles in order and agree them before filling in the rest.
3. `slides build deck/outline.json --out deck/<name>.pptx`.
   - Exit 2 with `{errors: [...]}`: fix every error listed (the outline, the arguments, the `--out` path or a
     picture) and build again.
   - Exit 1 with `{error}` is a fault in the script, not the outline: tell the person rather than retrying.
   - `warnings` in the result (also on stderr) are text over a layout's limits. Shorten the text or split the slide,
     rather than leaving it crowded. Only keep it if the person says so.
4. Tell the person where the file is, how many slides it has, and any warnings left.

## The outline

```json
{
  "title": "Ways of working",
  "subtitle": "A developer's guide to the software development life cycle",
  "notes": "Speaker notes for the title slide",
  "slides": [
    { "id": "why", "layout": "HMCTS_SECTION", "title": "Why it matters" },
    {
      "layout": "HMCTS_CONTENT",
      "title": "What's to do with me?",
      "bullets": ["The team decides the process", { "text": "There are templates", "bullets": ["Scrum", "Kanban"] }],
      "notes": "What to say on this slide"
    },
    { "layout": "HMCTS_TWO_COLUMN", "title": "Ready and done", "left": ["…"], "right": ["…"] },
    { "layout": "HMCTS_IMAGE", "title": "Our pipeline", "image": { "path": "pipeline.png", "alt": "…" }, "caption": "…" },
    { "layout": "HMCTS_CLOSING", "title": "Questions?", "subtitle": "#our-team-channel on Slack" }
  ]
}
```

- The title slide (`HMCTS_TITLE`) is made from the outline's own `title`, `subtitle` and `notes`. Don't list it in
  `slides`.
- Every slide takes `layout`, its layout's fields, and optionally `notes` (speaker notes) and `id`, a name of your own
  that stays with the slide if slides are reordered. `id` is never shown.
- Bullets are strings, or `{text, bullets: [strings]}` for one nested level. Nothing nests deeper.
- Image paths are relative to the outline file. PNG, JPEG or GIF.

## Writing good slides

- **One idea per slide.** If a slide needs a second heading, it is two slides.
- Slide titles say the point ("Releases take three weeks"), not the topic ("Releases").
- Put the detail in `notes`, not on the slide. Bullets are prompts, not sentences to read out.
- Use `HMCTS_SECTION` to mark each part of a talk longer than about eight slides.

## Accessibility

- **Every picture has alt text** saying what it shows and why it is there, such as "Bar chart: releases fell from 12 to
  4 a month after the freeze". The build refuses a picture with neither `alt` nor `decorative: true`. Use
  `decorative: true` only for a picture that adds nothing, and then give no alt.
- **No text in pictures.** Screen readers can't read it, it doesn't scale, and it can't be translated. Put the words
  in a bullet or the caption, and use the picture for what only a picture can show. A screenshot is fine when the
  screen itself is the point; describe what matters in the alt text.
- **Contrast is handled by the layouts** (white on navy, black or dark grey on white). Don't ask for other colours, and
  don't use a picture whose own text or detail is low-contrast.
- **Give every slide its own meaningful title**: titles are how a screen reader user moves through the deck. The build warns about two slides with the same title.
- Don't rely on colour alone to make a point in a picture.

When this skill hits a gap or a wrong statement in the docs, tell the user and offer to update the plugin's
`README.md` in hmcts/dtsse-agent-hub.
