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
4. In a CFT Workspace conversation, publish it, so the person sees the slides beside the chat and can download them:
   `agent-hub deck put deck/outline.json --pptx deck/<name>.pptx --summary "<what changed>"`. It uploads the
   pictures the outline names, saves the outline as the deck's next version and then the `.pptx` built from it. It
   also writes the id it gave each slide back into `outline.json`; keep them, since they are how the person points
   you at a slide. Outside a conversation there is nowhere to publish, and the command says so. For an outline
   `agent-hub deck get` wrote (below), `deck put` sends the version `deck get` read as `--base` by itself, so a
   newer version the person wrote meanwhile is refused rather than overwritten; don't pass `--base` yourself.
   - "the deck has changed since version N": someone else wrote a newer version. Start again from
     `agent-hub deck get`, make your change to that, build it, and put it with the `--base` the message gives.
   - "a conversation holds at most … bytes of pictures": the latest 3 versions, which the hub never deletes to make
     room, name too many pictures between them. Put versions that name fewer pictures, then try again; if it is still
     refused, tell the person.
   - "a deck uses at most … bytes of pictures": the pictures the latest version names, with any uploaded in the last
     hour, are at the limit. Put a version without the pictures you are replacing first, then put the one with the
     new pictures; if it is still refused, the old ones were uploaded under an hour ago, so tell the person.
   - "published the slide deck as version N, but its .pptx did not reach the hub": the outline is saved and only
     the file is missing. Do not run `deck put` again, which would publish another version. Run the command the
     message gives, `agent-hub deck pptx deck/<name>.pptx --version N`, which sends the `.pptx` alone.
5. Tell the person how many slides it has and any warnings left. In a conversation they already see it; elsewhere,
   say where the file is.

## Changing a deck that is already there

In a CFT Workspace conversation, always start from the published deck rather than an outline you remember:
`agent-hub deck get` writes it to `~/.agent-hub/decks/<conversation>/outline.json` with its pictures beside it,
ready for `slides build`, records the version it read in `version` beside them, and prints the `deck put` to run
when you have changed it. Change that `outline.json` in place: `deck put` reads its base from there. `--json` says where it is and
which version, and whether the person can download its `.pptx` yet.

A message that starts with a slide reference, such as `[Slide 4 of "Ways of working" v7, id s_ab12: "Releases take
three weeks"]`, is the person asking about that slide. Read it with `agent-hub deck get --slide s_ab12`, which
prints the slide as it is now (`number` is its place in the deck, the title slide being 1), and answer about it. If
they ask for a change, change that slide in the outline `deck get` wrote, build and put the deck as above. Slide 1, the
title slide, has no id: it is the outline's own `title`, `subtitle` and `notes`.

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
