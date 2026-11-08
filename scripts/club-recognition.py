#!/usr/bin/env python3
"""Bounded, cached club recognition observations for quiz generation."""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import popularity as source


def club_candidates(directory):
    index = json.loads((directory / "index.json").read_text())
    # club_count is an internal field expected by the shared source collector.
    clubs = {row[3]: {"name": row[0], "club_count": 1} for row in index["clubs"]}
    if len(clubs) != len(index["clubs"]):
        raise ValueError("Club QIDs must be unique")
    return index["built"], clubs


def collect(args):
    built, clubs = club_candidates(args.site_data)
    if args.qids:
        wanted = set(args.qids.split(","))
        if wanted - clubs.keys():
            raise ValueError("--qids must name core clubs")
        clubs = {qid: row for qid, row in clubs.items() if qid in wanted}
    journal = source.Journal(args.state)
    client = source.Client(args.max_requests, args.max_seconds)
    months = source.month_window()
    errors, stopped = 0, False
    try:
        errors, stopped = source.collect(clubs, journal, client, months)
    finally:
        journal.compact()
        report = source.audit(clubs, journal, months, built, client.count, errors, stopped)
        client.session.close()
    previous = None
    if args.output.exists():
        saved = json.loads(args.output.read_text())
        previous = {**saved, "kind": "recognition-snapshot", "players": saved["clubs"], "candidate_count": len(saved["clubs"])}
        source.validate_snapshot(previous)
    snapshot = source.make_snapshot(report, previous)
    snapshot["kind"] = "club-recognition-sources"
    snapshot["scope"] = "core club pages; separate from player observations and published quiz assets"
    snapshot["clubs"] = snapshot.pop("players")
    for row in snapshot["clubs"].values():
        row.pop("club_count", None)
    source.atomic_json(args.output, snapshot, compact=True)
    print(json.dumps({"clubs": len(clubs), "requests": client.count, "errors": errors,
                      "budget_exhausted": stopped, "summary": snapshot["summary"], "output": str(args.output)}, indent=2))
    return int(bool(errors))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-data", type=Path, default=ROOT / "site/data")
    parser.add_argument("--state", type=Path, default=ROOT / "data/club-recognition/state.jsonl")
    parser.add_argument("--output", type=Path, default=ROOT / "data/club-recognition/snapshot.json")
    parser.add_argument("--qids")
    parser.add_argument("--max-requests", type=source.positive_int, default=600)
    parser.add_argument("--max-seconds", type=source.positive_int, default=600)
    args = parser.parse_args(argv)
    if ((ROOT / "site").resolve() in args.output.resolve().parents
            or args.output.resolve() == (ROOT / "data/popularity/snapshot.json").resolve()):
        parser.error("club observations must remain separate from published assets and player snapshots")
    return collect(args)


if __name__ == "__main__":
    raise SystemExit(main())
