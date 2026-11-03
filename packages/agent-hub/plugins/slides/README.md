# The slides plugin

HMCTS-branded PowerPoint decks from an outline. The `/slides:deck` skill asks who the deck is for, what it is for and
how long it should be, writes an outline, and runs `scripts/slides build`, which turns the outline into a `.pptx`.

The agent hub carries the plugin and puts it on the virtual agent of anyone who ticks **HMCTS slide decks** in the
CFT Workspace's Settings, under Tools.

## Layouts, not shapes

A deck is made only of the layouts below. The model picks a layout for each slide and writes its fields; the script
places everything. Each layout is a real slide layout in the deck, named as below, with named placeholders, so the
deck opens in PowerPoint with the HMCTS layouts in **Home > Layout**, and a slide can be edited, or a new one added,
without losing the brand.

| Layout | Placeholders | Use |
| --- | --- | --- |
| `HMCTS_TITLE` | `title`, `subtitle` | Opening slide on the HMCTS artwork. Made from the outline's own title and subtitle |
| `HMCTS_SECTION` | `title` | Navy divider for each part of the talk |
| `HMCTS_CONTENT` | `title`, `body` | Navy title bar and bullets |
| `HMCTS_TWO_COLUMN` | `title`, `left`, `right` | Navy title bar and two columns of bullets |
| `HMCTS_IMAGE` | `title`, `image`, `caption` | Navy title bar, one picture fitted without cropping, and a caption |
| `HMCTS_CLOSING` | `title`, `subtitle` | Closing slide on the HMCTS artwork |

`slides layouts` prints these with every field and limit as JSON, which is what the skill reads.

The look is the "Ways of working" deck's: 16:9 at 10 × 5.625in, Arial, a navy (`#073763`) bar 1.16in deep with a
24pt white title, 18pt black bullets at 150% line spacing (● then ○), and the title slide's crest-and-skyline
artwork (`scripts/slides-lib/assets/hmcts-title-background.png`). The section, two-column and closing layouts are
not in that deck and are made from its bar, colours and type. Slides carry no slide number, as in the deck.

## Running it

```
scripts/slides layouts
scripts/slides build <outline.json> --out <file.pptx>
```

Needs Node 22.18 or later, which runs the TypeScript sources directly. The first run installs the dependencies
(pptxgenjs, image-size and jszip) into `scripts/slides-lib/node_modules`; `scripts/slides deps` does only that. No
Python.

The outline is JSON:

```json
{
  "title": "Deck title",
  "subtitle": "Optional subtitle",
  "notes": "Optional speaker notes for the title slide",
  "slides": [
    { "id": "optional-own-name", "layout": "HMCTS_CONTENT", "title": "…", "bullets": ["…", { "text": "…", "bullets": ["…"] }], "notes": "…" },
    { "layout": "HMCTS_IMAGE", "title": "…", "image": { "path": "picture.png", "alt": "What it shows" }, "caption": "…" }
  ]
}
```

- Bullets nest one level.
- An image is `{path, alt}` or `{path, decorative: true}`; `path` is relative to the outline file, and a PNG, JPEG
  or GIF. Alt text goes into the picture's description; a decorative picture is marked decorative instead.
- `id` is the caller's own name for a slide, kept in the plan and never shown.

`build` refuses an outline with an unknown layout, a missing or unknown field, bullets nested too deep, a picture
with neither alt text nor `decorative`, or a picture that doesn't exist or whose contents are not the PNG, JPEG or
GIF its name says, listing every problem (`{errors}` on stdout, exit 2). Text over a layout's limits is only a
warning, on stderr and in the result's `warnings`.

Every command prints one JSON object on stdout:

| Exit | stdout | Means |
| --- | --- | --- |
| 0 | the result | done |
| 2 | `{errors: [...]}` | something the caller can fix: the outline, the arguments, an `--out` that cannot be written, or a picture that cannot be read |
| 1 | `{error}` | a fault in the script itself, with its stack on stderr |

## How it is built

`scripts/slides-lib/masters.ts` is the whole of the layout: slide size, colours, type, each master's fixed elements
and placeholders, their limits, `plan(outline)`, which lays each slide out as boxes in reading order, and
`lint(outline)`. It imports nothing, so a browser preview can use the same file. `build.ts` turns the masters into
pptxgenjs slide masters and puts each box into its placeholder, computing no positions of its own. It then corrects
three things pptxgenjs 4.0.1 cannot be told: the default 20% space before each body paragraph, how far a bullet hangs
left of its text, and marking a picture decorative.

Known limits of pptxgenjs 4.0.1: the picture placeholder is written without `type="pic"`, so PowerPoint treats it as
a content placeholder (which takes a picture all the same); and a layout's placeholders carry the first level's text
style only, so a nested bullet added by hand in PowerPoint takes its bullet from the slide master.

## Tests

```
cd scripts/slides-lib && npm ci && npm test && npx tsc -p .
```

`yarn workspace @hmcts-cft/agent-hub run test` runs these too. The build test writes a real deck, unzips it, and
checks that the layouts exist, that each slide uses the right one, and that its placeholders are filled.
