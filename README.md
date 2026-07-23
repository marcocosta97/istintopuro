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

The quiz generator's difficulty bands live in one table at the top of
`site/quiz.js` — rated by how famous the answer set is, not the clubs.
Fame discounts pre-1970s tallies, requires actual appearances before the
recency bonus counts, and credits careers at marquee clubs outside the
puzzle pair. Each day's draw replays the schedule chain within its 90-day
window and avoids the previous 10 days' pairings (previous 2 days' clubs). After a
dataset refresh `quizDebug(30)` in the console prints the
next month of puzzles for a sanity check. Puzzles are numbered from a
fixed launch Monday. Game state and streaks persist in `localStorage`
(`quiz`, `quizStats`), pinned to club QIDs so a mid-day refresh can't
swap a puzzle mid-game. A third key, `quizHistory`, records each finished
day's four stage outcomes plus its club QIDs — the archive calendar shows
every past Schedina as a 2×2 block of those outcomes and replays any day
from its stored QIDs (an unplayed day is regenerated from the date).
Replays are practice: they fill the calendar but never touch the streak,
and their in-progress state is kept per day (`quizReplays`) so you can move
between today and a past day without losing either.

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
