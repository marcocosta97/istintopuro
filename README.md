# Istinto Puro — quiz & solver

Two ways to play the game «Istinto Puro». The solver: pick clubs and
instantly get every player who wore all of those shirts — or switch to
player mode and go the other way: pick players, get the clubs they shared.
The daily quiz mode (`site/quiz.js`) turns the same index into a Wordle-style
game: four intersections of rising difficulty, generated deterministically
from the date, so everyone on the same dataset build plays the same puzzle.

Live at **[istintopuro.mcosta.it](https://istintopuro.mcosta.it)**.

## How it works

Everything runs in the browser. The dataset — ~62k players and 474 clubs
covering the top-5 European leagues and their second divisions, all-time —
is extracted from Wikidata and precomputed into a static index that the
client intersects in under a millisecond. Careers, photos (Wikimedia
Commons), nationalities and loan spells all come from the same extraction.
No server, no tracking.

The emitted data formats are documented in `pipeline/pipeline.py`'s
docstring; heuristics and quality passes are commented where they live,
in the pipeline and in `site/app.js`.

Quiz difficulty is rated by how recognisable the answer set is, not the
clubs; the tuning lives in one table at the top of `site/quiz.js`, and
`quizDebug(30)` in the console prints the next month of puzzles to
sanity-check after a dataset refresh. An archive calendar replays past
days for practice; game state persists in `localStorage`.

## Refreshing the data

```
python3 pipeline/pipeline.py            # full fetch from Wikidata (~40 min)
python3 pipeline/pipeline.py build      # rebuild site/data from checkpoints
```

A weekly GitHub Action re-runs the pipeline and deploys; the `validate`
stage blocks a malformed or shrunken dataset. One list needs a human:
`CURRENT` in `pipeline.py` (each league's clubs this season) — refresh it
every August.

## Running locally

```
python3 -m http.server -d site 8000
```

Pushing to `master` deploys `site/` to GitHub Pages.

## License

MIT. Data derived from [Wikidata](https://www.wikidata.org) (CC0);
photos are served by Wikimedia Commons under their own licenses.
The [Barlow Semi Condensed](https://github.com/jpt/barlow) typeface
(`site/fonts/`) is © The Barlow Project Authors, SIL OFL 1.1.
