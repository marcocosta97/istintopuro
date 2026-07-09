# Istinto Puro — solver

Solver per il gioco "Istinto Puro" (Fontana di Trevi): scegli 2+ squadre,
ottieni all'istante tutti i giocatori che hanno vestito tutte le maglie.

## How it works

- **No backend.** The whole dataset (~78k players, ~196k player–club pairs,
  574 clubs from the top-5 leagues + their second divisions, all-time) is
  precomputed into `site/data/index.json` as an inverted index
  (club → delta-encoded sorted player IDs). The browser intersects posting
  lists client-side in well under a millisecond.
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

## Serve

Any static file server:

```
python3 -m http.server -d site 8000
```
