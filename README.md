# Istinto Puro — quiz & solver

Two ways to play the game «Istinto Puro». The solver: pick clubs and
instantly get every player who wore all of those shirts — or switch to
player mode and go the other way: pick players, get the clubs they shared,
or pick one and get everyone he ever lined up alongside.
The daily quiz mode (`site/quiz.js`) turns the same index into a Wordle-style
game: four intersections of rising difficulty. A versioned static schedule keeps
published days stable across dataset refreshes and deterministically prepares the
next fortnight, so everyone plays the same puzzle.

Live at **[istintopuro.mcosta.it](https://istintopuro.mcosta.it)**.

## How it works

Everything runs in the browser. The dataset — ~69k players and 474 clubs
covering the top-5 European leagues and their second divisions, all-time —
is extracted from Wikidata and precomputed into a static index that the
client intersects in under a millisecond. Photos (Wikimedia Commons),
nationalities and loan spells come from the same extraction; careers that
Wikidata leaves incomplete are filled from the English Wikipedia infobox.
Players are found through their Wikidata club statements, which recent
items increasingly lack altogether — so current squads are additionally
seeded from the squad table on each club's Wikipedia article, and their
careers come entirely from the infobox. No server, no tracking.

The emitted data formats are documented in `pipeline/pipeline.py`'s
docstring; heuristics and quality passes are commented where they live,
in the pipeline and in `site/app.js`.

Quiz difficulty is rated by how recognisable the answer set is, not the
clubs; the tuning lives in `site/quiz-core.js`, and
`quizDebug(30)` in the console prints the next month of puzzles to
sanity-check after a dataset refresh. A stage is usually two clubs; the
two hardest each toss a seeded daily coin for a three-club variant, which
plays as a different flavour of hard rather than simply a harder one. An
archive calendar replays past days for practice; game state persists in
`localStorage`. New schedules reject the same order-independent club
combination for 30 days and any individual club for two days.

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
of the counts the shrink guards watch. One list needs a human:
`CURRENT` in `pipeline.py` (each league's clubs this season) — refresh it
every August.

## Running locally

```
python3 -m http.server -d site 8000
```

Pushing to `master` deploys `site/` to GitHub Pages, stamping every asset URL
with the commit sha.

The site installs and runs offline: `site/sw.js` precaches the app itself and
keeps the data files it has been asked for, one version of each. Nothing is
cached unversioned — the code carries the deploy's sha, the dataset its build
date — and the page itself is always fetched from the network first, since it is
the file that names those versions. Should the worker ever need pulling, deploy
one whose `install` unregisters it and clears `caches`; browsers revalidate the
worker script on every load, so clients drop it by themselves.

## License

MIT. Data derived from [Wikidata](https://www.wikidata.org) (CC0);
photos are served by Wikimedia Commons under their own licenses.
The four flags in `site/flags/` (Yugoslavia, the GDR, Kosovo, the
Netherlands Antilles — states Unicode has no emoji flag for) are
public domain, from Wikimedia Commons.
The [Barlow Semi Condensed](https://github.com/jpt/barlow) typeface
(`site/fonts/`) is © The Barlow Project Authors, SIL OFL 1.1.
