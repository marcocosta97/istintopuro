# Istinto Puro — solver

Solver per il gioco "Istinto Puro" (Fontana di Trevi): scegli 2+ squadre,
ottieni all'istante tutti i giocatori che hanno vestito tutte le maglie.

## How it works

- **No backend.** The whole dataset (~62k players, ~172k player–club pairs,
  480 clubs from the top-5 leagues + their second divisions, all-time) is
  precomputed into `site/data/index.json` as an inverted index
  (club → delta-encoded sorted player IDs, plus per-pair appearances and
  goals, `-1` = unknown). The browser intersects posting lists client-side
  in well under a millisecond.
- **Careers** are sharded into `site/data/career/*.json` (128 files) and
  lazy-loaded when a player row is expanded.
- **Photos** are the only runtime external dependency: thumbnails lazy-loaded
  from Wikimedia Commons, with initials fallback.

## Data pipeline

Source: Wikidata (P54 team memberships + qualifiers for years/apps/goals).

```
python3 pipeline/pipeline.py            # all stages, checkpointed in data/
python3 pipeline/pipeline.py build      # rebuild site/data from checkpoints
```

Stages: `clubs → members → attrs → careers → teams → build`. Each stage
checkpoints to `data/*.json(l)`; delete a checkpoint to force a re-fetch.
Full run issues ~600 SPARQL queries (~40 min, politeness-throttled).

Quality passes in `build`: P54 statements with no qualifiers at all
(no years/apps/goals) are discarded as unreliable, re-founded "phoenix"
clubs are merged into one entry, and national sides are filtered out of
career panels. The index is stamped with the extraction date (newest
checkpoint), shown in the site footer.

## Serve

Any static file server:

```
python3 -m http.server -d site 8000
```

Pushing to `master` auto-deploys `site/` to GitHub Pages
(`.github/workflows/pages.yml`).

## License

MIT. Data derived from [Wikidata](https://www.wikidata.org) (CC0);
photos are served by Wikimedia Commons under their own licenses.
