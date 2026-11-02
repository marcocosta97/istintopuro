# Development

Technical notes for maintaining [Istinto Puro](../README.md).
Run the commands below from the repository root.

## Data and quiz architecture

Everything runs in the browser. The core dataset — ~72k players and 469 clubs
covering the top-5 European leagues and their second divisions, all-time —
is extracted from Wikidata and precomputed into a static index that the
client intersects in under a millisecond. Optional country packs add their
top two divisions only when a user enables them: Portugal, the Netherlands,
Belgium, Turkey, Brazil and Argentina. Reserve teams are excluded.
The daily quiz deliberately remains core-only, so its puzzles stay identical
for everyone. Photos (Wikimedia Commons),
nationalities and loan spells come from the same extraction; careers that
Wikidata leaves incomplete are filled from the English Wikipedia infobox.
Players are found through their Wikidata club statements, which recent
items increasingly lack altogether — so current squads are additionally
seeded from the squad table on each club's Wikipedia article, and their
careers come entirely from the infobox. No server, no tracking.

The emitted data formats are documented in `pipeline/pipeline.py`'s
docstring; heuristics and quality passes are commented where they live,
in the pipeline and in `site/app.js`.

The daily quiz uses shared recognition rules for easy, medium, hard and
impossible, with two or three club clues per stage. Selection prefers unused
intersections and enforces repetition cooldowns. An archive replays past days;
progress persists in `localStorage`. See [the generator](quiz-generator.md)
for the rules and schedule controls. `quizDebug(30)` previews the next month
in the browser console.

## Local development

```
python3 -m http.server -d site 8000
```

Pushing to `master` deploys `site/` to GitHub Pages, stamping every asset URL
with the commit sha.

## Checks

The checks and data pipeline use Python 3 with `requests`, plus Node.js.
CI runs Python 3.13 and Node.js 22. Serving the existing site only needs Python.

```sh
python3 -m pip install requests==2.32.3
sh scripts/check.sh
```

This checks JavaScript syntax, runs the Python and Node.js tests, validates
published data, and checks the quiz schedule.

Recognition calibration tests use the fixed inputs described in
[`tests/fixtures/README.md`](../tests/fixtures/README.md). Exact scores, answer
counts and named-player examples belong there. Tests on the current dataset
check invariants and the 730-day quiz quality bounds; legitimate source edits
must not require updating a hard-coded score every week.

## Refreshing the data

```
python3 pipeline/pipeline.py            # full fetch first time; later runs reuse unchanged source revisions
FULL_REFRESH=1 python3 pipeline/pipeline.py  # ignore incremental state and audit every source record
python3 pipeline/pipeline.py build      # rebuild site/data from checkpoints
python3 pipeline/pipeline.py quiz       # regenerate/validate the static quiz horizon
node scripts/quiz-schedule.js --audit   # deterministic 730-day balance audit
```

A weekly GitHub Action re-runs the pipeline and deploys; the `validate`
stage blocks a malformed or shrunken dataset, one whose apps coverage
dropped, one whose spell years stopped lining up with the postings they
describe, and one where too few squad-table seeds survived — half the careers
come from the Wikipedia overlay, and for seeded players it is their only
source, so a broken parse degrades or empties the data without changing any
of the counts the shrink guards watch. Pack indexes, lazy career shards and
spell-year files pass the same structural and coverage checks independently.
Appearance coverage has an 85% floor, except Brazil (75%): its historical
source infoboxes often omit totals. Unknown counts stay unknown; the same
two-percentage-point baseline regression guard applies to every pack.
One list needs a human:
`CURRENT` in `pipeline.py` (each league's clubs this season) — refresh it
every August, and at the start of the calendar-year seasons for Brazil and Argentina.

Every weekly run adds a baseline/candidate comparison to its job summary:
player and posting counts, appearance coverage, and representative quiz score
and classification changes. Probe changes are advisory; the existing data and
calendar guards still block invalid releases. To compare two indexes locally:

```sh
node scripts/refresh-report.js --baseline /tmp/baseline-index.json --candidate site/data/index.json --output /tmp/refresh-report
```

A failed refresh or release check uploads a `refresh-diagnostics-RUN-ATTEMPT`
artifact retained for seven days. It contains the candidate `site/data` captured
before any fallback, the core and pack baselines, pipeline/check logs, and the
comparison in JSON and Markdown. A failed source refresh may leave a partial
candidate; the report records unreadable inputs as diagnostics. For reproduction,
check out the SHA in `report.json`, replace `site/data` with the artifact's
`candidate` directory, then run `sh scripts/check.sh`. To repeat baseline data
validation too, run:

```sh
VALIDATE_PUBLISHED_ONLY=1 VALIDATE_BASELINE=/tmp/baseline-index.json VALIDATE_PACK_BASELINE_DIR=/tmp/pack-baselines python3 pipeline/pipeline.py validate
```

Use the paths to the extracted artifact's baselines in that command. Reporting
and artifact upload are best-effort and do not change whether the checks pass.

## Offline play

The single “Play offline” switch in Settings downloads and maintains the complete
game together with every enabled country pack. It defaults to on in the installed
PWA and off in an ordinary browser tab; an explicit choice is remembered across
visits. Registration and worker updates alone do not trigger a download.
The complete core offline copy includes
the interface, local fonts and flags, index, quiz schedule, all career shards
(including quiz hints), and teammate spell-year files. This is about 26 MB of
JSON stored, or 8 MB transferred with gzip, excluding portraits. Settings shows
combined download progress and a retry control, and requests persistent browser
storage when offline play is enabled. Wait for “Ready to play offline” before
disconnecting; installing the PWA alone does not mean the download has finished.

Enabled country packs automatically download their full index, careers, and
teammate data whenever offline play is on, including packs enabled later. The
ready status requires the core and every enabled pack to be complete. All six
packs add about 18 MB stored, or 5 MB with gzip. Disabling a pack removes its
offline and runtime data. Wikimedia portraits use initials when offline or when the image fails;
external Wikipedia/Wikidata pages still require a connection.
Turning offline play off stops pending downloads and automatic updates; already
saved data and quiz progress are preserved.

`site/offline.js` defines each download's inventory. `site/sw.js` marks a release
ready only after every file is stored. Worker activation is lightweight and
does not download the game. A failed download preserves the previous complete
release; one complete predecessor is retained after a download finishes.
Code and indexes are keyed by the deploy sha, career
and teammate files by dataset build date. Navigation tries the network first
and falls back to the complete saved release, including for HTTP server errors.
Storage can still be cleared by the user or evicted unless persistence is
granted; readiness is checked again when Settings opens.

The saved schedule covers 90 days after the dataset build and normal refreshes
preserve every previously published date, including future ones. After that
horizon, local generation remains playable but can differ from a newer online
dataset. Reconnect to download a newer release and extend the shared schedule.
