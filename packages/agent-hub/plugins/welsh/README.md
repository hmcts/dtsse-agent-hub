# The welsh plugin

Welsh translations for any CFT service, with no machine translation. Business analysts (and the engineers helping
them) use it to:

- find English that is missing its Welsh, and send it to the Welsh Language Unit (WLU)
- put the Welsh that comes back into the service's catalogue and its code
- add Welsh content to Jira stories

The agent hub carries the plugin and puts it on the virtual agent of anyone who ticks **Welsh translations** in the
CFT Workspace's Settings, under Tools.

## Nothing here translates

Every Welsh string a user sees has to come from the WLU. The only Welsh this plugin writes, to code, to Jira or to a
catalogue, is one of:

1. **A row in the service's catalogue**, an earlier WLU answer with its source recorded.
2. **A row in a spreadsheet the WLU returned**, whose Ref still matches its English.

This is enforced in code, not only in instructions. Before any write, `verify` checks each Welsh value against those
two sources and refuses anything it can't trace. The `/welsh:translations` skill drives the script but never composes
Welsh: even a "corrected" mutation or apostrophe would fail `verify`, and the skill sends a doubtful string back to the
WLU instead. `welsh verify` runs the same check on demand, so a reviewer or a CI job can confirm a branch's Welsh came
from the WLU.

Matching is deliberately strict. Lookups compare English exactly, after folding only differences that can't change
meaning: curly versus straight quotes, runs of spaces, and quotes wrapped round the whole string. Case and punctuation
still count. Fuzzy matches help a BA search but never fill anything, because a near miss would be Welsh the WLU never
approved for that text.

## Where a service's Welsh lives

Each service keeps its Welsh in a `welsh/` folder in one of its own repos, its **home repo**. For CaTH that is
`cath-service`. Nothing names the home repo: it is whichever of the service's repos in cft-workspace's `workspace.yaml`
has `welsh/config.yaml` on its default branch. Setting a service up is adding that folder.

```
<home repo>/welsh/
  catalogue.csv            # the service's approved Welsh
  config.yaml              # which code to scan, and how
  returns/<name>.xlsx      # returned by the WLU, committed with the catalogue change it made
  needs-review.md          # every needs-review row and why; rewritten by each import

cft-workspace/apps/<product>/.welsh-work/   # ignored: the person's own working files
  requests/<date>-<label>.xlsx               # sent to the WLU
  stories/, scans/                           # story previews and scan results
```

The plugin reads `welsh/` from the home repo's default branch, never from a local checkout, and changes it only on a
branch of a temporary worktree. So every catalogue change is a pull request in that repo, reviewed by the team that
owns the code, and it records which WLU return it came from.

**Why each service has its own catalogue.** The right Welsh depends on where it is used:

- "of" in "page 3 of 6" is not the same word as "of" elsewhere.
- Yes and No are answered in Welsh by repeating the question's verb ("Ydw", "Oes", "Ydy"…).
- A list title can need a different mutation depending on what comes before it.

So there is no shared catalogue. A service only ever uses Welsh from its own, and if another service already has an
approved translation, it still goes to the WLU for this one. Inside a catalogue, context is kept three ways:

- **A `context` column.** The same English can have several approved rows, one per context.
- **Ambiguity goes to a person.** With more than one approved rendering, or alternatives in one cell, a BA chooses.
- **A context-sensitive list.** Yes and No are built in, and a service can add more. These are never filled
  automatically, even when there is only one rendering.

## Using it

**Business analysts** use the CFT Workspace's **Welsh translations** page: the **+** button beside New chat in the sidebar, then **Welsh translations**, once the plugin
is ticked, or `/assistant/welsh`. It runs the commands below in their own assistant, with their own GitHub and Jira
sign-ins.

**Engineers** can install it into Claude Code, then ask in plain words or use `/welsh:translations`:

```bash
claude plugin marketplace add hmcts/dtsse-agent-hub
claude plugin install welsh@dtsse-agent-hub
```

Or run the script directly, from inside a cft-workspace checkout, which is how it finds the workspace (or set
`CFT_WELSH_WORKSPACE`). Below, `$WELSH` is the plugin's `scripts/welsh`. Every command takes `--service <product>`,
the directory under cft-workspace's `apps/` (`cath`, `pcs`, `nfdiv`, …). Results are JSON on stdout, with a summary
on stderr. The first run installs the script's dependencies.

### Set a service up

```bash
$WELSH init --service <product> --repo apps/<product>/<repo> --pr
```

This opens a draft PR in that repo adding `welsh/`, with an empty `catalogue.csv`, a `config.yaml` and a `returns/`
folder. In `config.yaml`, list the repos to scan and the adapter for each; `.` is the home repo itself. The service is
ready once the PR is merged.

If the team already has a WLU spreadsheet or a JSON catalogue, seed the catalogue from it:

```bash
$WELSH import-legacy --service <product> --xlsx "<catalogue>.xlsx" [--json <copy>.json] --pr
```

Where a spreadsheet and a JSON copy have the same English, the spreadsheet wins. English with more than one Welsh
rendering is added as `needs-review`, and so is anything else that needs checking. Every `needs-review` row is listed
with why in `welsh/needs-review.md`, the one list to work through. Settle each with the WLU, then set one row to
`approved` and the others to `superseded`. A WLU return with the same Welsh approves the row by itself.

### Search the catalogue

```bash
$WELSH search "back to top" --service cath           # contains, English or Welsh side
$WELSH search "Continue" --service cath --exact
$WELSH search "hearing list" --service cath --fuzzy
```

Results show each row's `status`. Only `approved` rows are ever used to fill anything. Add `--all` to include
`superseded` rows.

### Find missing Welsh and ask the WLU for it

```bash
$WELSH scan --service cath                 # repos in config.yaml
$WELSH scan --service cath --request       # also write the WLU spreadsheet
$WELSH scan --service cath --request --leave-out CY-1A2B3C4D   # without a string the BA says needs no Welsh
$WELSH keep-english --service cath --pr -- "Rolls Building"   # and stop asking about it: a draft PR to identical_allowlist
```

The scan reads the latest code on each repo's default branch. It reports every place English has no proper Welsh: a
missing file or key, an empty value, a `[WELSH TRANSLATION REQUIRED]` marker, a placeholder such as "Welsh
placeholder" or a `cy` prefix, or Welsh that is just the English copied over. Then it sorts the strings into:

- **Already in the catalogue.** Apply them now; there's no need to ask the WLU.
- **Needs a BA choice.** More than one approved rendering, or context-sensitive English such as Yes/No. These are in
  the WLU spreadsheet too, for the WLU to confirm.
- **New for the WLU.** One row per English string, listing where it is used. Only the Welsh column is editable. Each
  has `hint` when it probably needs no Welsh, in words for the BA: part of an address, a cookie's or a system's name,
  or text built by code. A hint is only a suggestion; the Welsh page starts those unticked, and the BA decides. A link
  to a place on the page (`#field-id`) is never content, so it is not reported at all.

**Only public-facing pages need Welsh.** Pages behind a staff role (admin and system-admin screens) are listed under
`staff_only` in `config.yaml` and never scanned. To find them, look for routes behind `requireRole` for staff roles, or
where the service hides its Welsh toggle. To stop a correct identical value being reported (an address the WLU says
stays in English, say), add it to `identical_allowlist`: `keep-english` does that in a draft PR to the home repo, keeping
the file's comments. It quiets only Welsh that is the English already; a key with no Welsh at all is still reported.

### Add a WLU return to the catalogue

```bash
$WELSH import ~/Downloads/2026-10-28-scan-cath-service.xlsx --service cath --dry-run
$WELSH import ~/Downloads/2026-10-28-scan-cath-service.xlsx --service cath --pr
```

Every row is checked before it is used:

- the Ref still matches the English. A Ref is a hash of the service and the English, so a changed English or a row from
  another service shows up
- the Welsh is not blank or a placeholder
- every placeholder from the English is still there, in any of the forms the services use: `{{name}}`, `${name}`,
  `%{name}`, `{name}`, `{0}`, `((name))`, `%NAME%`, `%s` or `%d`

Rows that pass are added to `welsh/catalogue.csv`, and the return itself goes into `welsh/returns/`. Rows that fail go
into a queries spreadsheet, with the reason, to send back. Welsh that disagrees with an approved row is added as
`needs-review` rather than replacing it. Every import is committed on a branch of the home repo; `--pr` also opens a
draft PR there.

### Put approved Welsh into the code

```bash
$WELSH apply --service cath --from catalogue --dry-run
$WELSH apply --service cath --from ~/Downloads/<return>.xlsx --dry-run
$WELSH apply --service cath --from catalogue --test --pr
```

`apply` re-scans, writes each Welsh value at its exact key changing only that string, runs `verify`, runs the repo's
tests with `--test`, and commits on a `welsh/<batch>-<time>` branch. With `--pr` it opens a draft PR listing every Ref,
file, English, Welsh and source for the developers to review. It works in a temporary worktree off the remote default
branch, so no checkout is touched, and clones the repo first if the workspace doesn't have it. `--dry-run` shows the
diff and keeps nothing.

Strings needing a BA choice are left alone until one is picked: find the row id with `search --exact`, then add
`--choose <Ref>=<row id>`. Anything `apply` can't write safely is listed as skipped, for a developer, and in the PR.
Examples are a Welsh file that doesn't exist yet, or a value built from an import.

### Add Welsh content to a Jira story

1. List candidate English strings (this only reads): `$WELSH story PUB-1234 --service cath`
2. Agree which are content, save them one per line copied exactly from the story, and preview:
   `$WELSH story PUB-1234 --service cath --strings strings.txt`. Catalogue matches are filled in, and every other row
   says `[WELSH TRANSLATION REQUIRED: "…"]`.
3. Write it: `$WELSH story PUB-1234 --service cath --write`. This appends a **Welsh content** section, or replaces the
   one already there, leaving the rest of the description alone. It refuses if someone has edited the story since the
   preview, and it saves a WLU request for the placeholder rows.
4. When the WLU replies, `import` the return, then `--refresh` and `--write` again.

If someone types Welsh into the section by hand, `--write` refuses: nothing shows it came from the WLU. Get it into the
catalogue through a return first.

### Check a branch's Welsh

```bash
$WELSH verify --service cath --repo apps/cath/cath-service [--base origin/master]
```

This lists every Welsh value the branch changed and whether each traces to an approved catalogue row or a WLU return.
It exits 1 if any doesn't, so it can gate a PR.

## Formats

### catalogue.csv

UTF-8 with a byte-order mark (so Excel shows Welsh diacritics), RFC 4180 quoting, CRLF line endings.

| Column | Meaning |
|---|---|
| `id` | SHA-1 of the English, context and Welsh, joined with NUL, first 10 hex characters. `--choose <Ref>=<id>` refers to it |
| `english` | Source text, without wrapping quotes or usage notes |
| `welsh` | Exactly as the WLU supplied it. Never normalised or edited |
| `context` | Where or how the phrase is used, when that changes the Welsh (`as in, page 3 *of* 6`, `button`). Blank means general |
| `notes` | Free text, such as the Ref it answered or why it is `needs-review` |
| `source` | `WLU:<return file>` or `legacy:<file>` |
| `received` | Date the row was added, `YYYY-MM-DD` |
| `status` | `approved` (used to fill), `needs-review` (shown in search, never used), `superseded` (history only) |

A lookup gives a **hit** (exactly one approved rendering, which is used), **ambiguous** (more than one rendering, a cell
with variants such as `[male] / [female]`, or context-sensitive English, for a BA to pick), or a **miss** (nothing
approved; near matches are shown as suggestions only).

### config.yaml

```yaml
repos:
  - path: .                           # this repo; another of the service's repos by its cft-workspace path
    adapters: [ts-locale-pair]        # default: all
    include: ["apps/web/src/**", "libs/**/src/**"]
    exclude: []                       # tests, dist and node_modules are always excluded
    staff_only: []                    # pages only HMCTS staff see: no Welsh needed, never scanned
    options: {}                       # json-pair: combined: [path/to/content.json]
    test: yarn test                   # run by apply --test
identical_allowlist: []               # English correctly identical in Welsh
placeholder_patterns: []              # extra regexes marking a value as a placeholder
context_sensitive: []                 # English never auto-filled (Yes and No are built in)
```

### Adapters

| Name | Pairs | Written how |
|---|---|---|
| `ts-locale-pair` | `en.ts`↔`cy.ts`, `<x>-en.ts`↔`<x>-cy.ts`. Exports pair by the same name, `en`↔`cy`, an `X`↔`XCy` suffix, or the only export on each side | TypeScript AST. Only the changed literal is touched, in its own quote style. Missing keys go in the deepest existing object. Arrow functions returning a template literal are leaves |
| `json-pair` | `…/en/…json`↔`…/cy/…json`, `en.json`↔`cy.json`, `*.en.json`↔`*.cy.json`, combined `{en, cy}` files (via `options.combined`) | Re-serialised with the file's own indent. New keys follow the English key order |

### What a scan reports

| Signal | Meaning |
|---|---|
| `missing-file` | No Welsh file for this English file |
| `missing-key` | The Welsh file lacks the key |
| `empty` | The Welsh value is blank |
| `marker` | `[WELSH TRANSLATION REQUIRED: …]` or `[TRANSLATE: …]` |
| `placeholder` | "Welsh placeholder", a `cy`/`cy ` prefix, `[Translation in progress]`, or a `placeholder_patterns` match |
| `identical` | The Welsh equals the English. Skipped for URLs, emails, short acronyms, kebab-case ids, allowlisted strings, and English the catalogue confirms is the same in Welsh |

### WLU spreadsheets

A request has a **Translations** sheet, `Ref | English | Welsh (WLU to complete) | Context / where it appears | Notes
for translator`, and an **About this request** sheet giving the batch, the service, the date and instructions. The sheet
is protected without a password, and only the Welsh column is unlocked. `Ref` is `CY-` and 8 hex characters, a hash of
the service and the English, so a string gets the same Ref from a scan or a story and one answer serves both.

A return can be any sheet whose header row (within the first 20 rows) has `Ref`, `English` and `Welsh`. A blank Welsh
cell counts as not done yet, not as a problem.

### Jira section

`story` adds a level-2 heading **Welsh content**, an italic note and a table `Ref | English | Welsh | Source`, written as
ADF so the rest of the description is kept. The section runs to the next heading at level 2 or above, and re-running
replaces it.

## Not covered yet

The scanner and writer understand `ts-locale-pair` (cath-service, the dtsse templates) and `json-pair` (the pcs, pt, et,
probate, civil-citizen-ui, sscs and cui-ra frontends). Check these by hand for now:

- `content.ts` step files with `languages = { en, cy }` (nfdiv, prl, adoption, sptribs, fis)
- Rails YAML (et-pet)
- `messages_cy.properties` (idam-web-public)
- the CCD/XUI Welsh dictionary (managed in ccd-admin-web)
- Flyway `_Cy` columns (civil-service)
- Notify Welsh template IDs and `WEL` document templates
- names seeded into a database, such as CaTH's `list-type-data.ts`
