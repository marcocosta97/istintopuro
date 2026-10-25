# Istinto Puro — quiz & solver

Two ways to play the game «Istinto Puro». The solver: pick clubs, leagues or
countries and instantly get every matching player — or switch to
player mode and go the other way: pick players, get the clubs they shared,
or pick one and get everyone he ever lined up alongside.
The daily quiz mode (`site/quiz.js`) turns the same index into a Wordle-style
game: four intersections of rising difficulty. A versioned static schedule keeps
published days stable across dataset refreshes and deterministically prepares the
next 90 days, so everyone plays the same puzzle even while offline.

Live at **[istintopuro.mcosta.it](https://istintopuro.mcosta.it)**.

## How it works

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
progress persists in `localStorage`. See [the generator](docs/quiz-generator.md)
for the rules and schedule controls. `quizDebug(30)` previews the next month
in the browser console.

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

## Running locally

```
python3 -m http.server -d site 8000
```

Pushing to `master` deploys `site/` to GitHub Pages, stamping every asset URL
with the commit sha.

When opened as an installed PWA, the site automatically downloads the complete
core game. In an ordinary browser tab, use the download button in Settings to
start the same download; registration and worker updates do not trigger it.
The complete offline copy includes
the interface, local fonts and flags, index, quiz schedule, all career shards
(including quiz hints), and teammate spell-year files. This is about 26 MB of
JSON stored, or 8 MB transferred with gzip, excluding portraits. Settings shows
download progress, retry controls, the saved daily-puzzle horizon, and an option
to request persistent browser storage. Wait for “Ready to play offline” before
disconnecting; installing the PWA alone does not mean the download has finished.

Enabled country packs have a separate “Save offline” button in Settings, which
downloads their full index, careers, and teammate data. All six add about 18 MB
stored, or 5 MB with gzip. Disabling a pack removes its offline and runtime
data. Wikimedia portraits use initials when offline or when the image fails;
external Wikipedia/Wikidata pages still require a connection.

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

## License

MIT. Data derived from [Wikidata](https://www.wikidata.org) (CC0);
photos are served by Wikimedia Commons under their own licenses.
The four flags in `site/flags/` (Yugoslavia, the GDR, Kosovo, the
Netherlands Antilles — states Unicode has no emoji flag for) are
public domain, from Wikimedia Commons.
The [Barlow Semi Condensed](https://github.com/jpt/barlow) typeface
(`site/fonts/`) is © The Barlow Project Authors, SIL OFL 1.1.
