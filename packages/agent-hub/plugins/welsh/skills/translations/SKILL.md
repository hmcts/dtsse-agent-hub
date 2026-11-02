---
name: translations
description: Manage Welsh translations for any CFT service without machine translation — search a service's Welsh catalogue, find English content missing its Welsh, build the spreadsheet for the Welsh Language Unit (WLU), add a WLU return to the catalogue, raise a PR putting approved Welsh into a repo, or add a Welsh content section to a Jira story. Use when a BA or engineer asks "what Welsh is missing in X", "is there an approved Welsh for Y", "the Welsh unit sent translations back", "PR these translations in", "add the Welsh to PUB-1234".
---

# Welsh translations

Drive `${CLAUDE_PLUGIN_ROOT}/scripts/welsh`, written `welsh` below. It works on every service, and finds the
cft-workspace from `$CLAUDE_PROJECT_DIR` (or `$CFT_WELSH_WORKSPACE`). Each service keeps its catalogue, config and
WLU spreadsheets in `apps/<product>/welsh/`; common terms live in `welsh/shared/catalogue.csv`.
Full guide: `docs/how-to/manage-welsh-translations.md` in the workspace.

## The rule that overrides everything else

**You never write Welsh.** Not a translation, not a "small fix", not a mutation or apostrophe
correction, not a suggestion in chat. Every Welsh string comes from the WLU, through a catalogue
row or a returned spreadsheet, and the script writes it. If Welsh looks wrong, tell the BA so
they can raise it with the WLU. `verify` blocks anything it can't trace, so improvising Welsh
fails anyway. It is also the one thing the user has said this tooling must never do.

You *may* choose which **English** strings are content (for example, from a story), as long as
each one appears in the source word for word.

## When to use

| The BA wants to… | Run |
|---|---|
| look up an approved Welsh phrase | `welsh search "<text>" --service <p>` (`--exact`, `--fuzzy`, `--all`) |
| know what Welsh is missing in a repo | `welsh scan --service <p> [--repo apps/<p>/<repo>]` |
| send the missing strings to the WLU | the same, plus `--request` → `apps/<p>/welsh/requests/<date>-….xlsx` |
| add a WLU return to the catalogue | `welsh import <file.xlsx> --service <p>` (`--dry-run` first, `--pr` to raise the workspace PR) |
| put approved Welsh into a repo | `welsh apply --service <p> --from catalogue\|<return.xlsx> --dry-run`, then without `--dry-run`, `--test --pr` |
| add Welsh content to a Jira story | `welsh story <KEY> --service <p>` (see below) |
| prove a branch's Welsh came from the WLU | `welsh verify --service <p> --repo <clone>` |
| set up a service for the first time | `welsh init --service <p>`, then fill `repos:` in `config.yaml` |

`--service` is the product directory under `apps/` (`cath`, `pcs`, `nfdiv`, …). Results are JSON
on stdout and the human summary is on stderr. Relay the summary and the table, not the JSON.

## Procedures

**Story (requirements 3 and 4)**
1. `welsh story <KEY> --service <p>` lists candidate English strings (quoted text, English
   table columns, lines after "the following … is shown:"). It is read-only.
2. Show the BA the list and agree which strings are content. Drop instructions such as
   `the existing "Start now" link remains unchanged`. Save the agreed list to a file, one string
   per line, copied exactly from the story.
3. `welsh story <KEY> --service <p> --strings <file>` builds a preview: catalogue matches
   filled, `[WELSH TRANSLATION REQUIRED: "…"]` everywhere else. Show the BA the table.
4. Rows marked "BA to choose" have several approved renderings, or are context-sensitive like
   Yes/No. Show the options (`welsh search --exact`) and rebuild with
   `--choose <REF>=<row id>` once the BA picks.
5. **Ask before writing to Jira.** Then run `--write`. It refuses if the story changed since the
   preview, and saves a WLU request for the placeholder rows.
6. When the WLU replies: `import` the return, then `story <KEY> --service <p> --refresh` and `--write`.

**Repo (requirements 1, 2 and 6)**
1. `scan` and report the three numbers: already in the catalogue, needs a BA choice, new for the WLU.
2. New strings: `scan --request`. Tell the BA where the spreadsheet is. They send it to the WLU.
3. On return: `import --dry-run`, show the problems (changed English, lost placeholders, unknown
   Refs), then `import`. Problem rows go into a `-queries.xlsx` for the WLU. **Ask before `--pr`.**
4. `apply --from <return.xlsx> --dry-run` (or `--from catalogue`), and show the diff summary.
   **Ask before running it for real.** Then `apply … --test --pr` opens a **draft** PR for the
   developers to review. Mention anything listed as skipped, since that needs a developer.

## Don't

- Don't translate, paraphrase, "tidy" or complete Welsh — see the rule above.
- Don't hand-edit `catalogue.csv` to add Welsh. Only `import` adds rows. A BA may change a row's
  `status` (`needs-review` → `approved`/`superseded`) once the WLU confirms.
- Don't use a `needs-review` row or a fuzzy `search` hit to fill anything.
- Don't add strings to `identical_allowlist` or `context_sensitive` yourself — those are the BA's
  call, usually after asking the WLU.
- Don't edit a clone by hand to "help" `apply`. It works in a temporary worktree off the default branch and never touches the checkout.
- Formats not covered yet (Rails YAML, `messages_cy.properties`, CCD dictionary, Flyway `_Cy`,
  Notify templates, `content.ts` steps) are listed in the how-to. Say so; don't improvise.

When this skill hits a gap or a wrong statement in the docs, tell the user and offer to update
`docs/how-to/manage-welsh-translations.md`.
