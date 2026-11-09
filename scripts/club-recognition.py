#!/usr/bin/env python3
"""Bounded, cached club recognition observations for quiz generation."""
import argparse
import calendar
import json
from pathlib import Path
import statistics
import sys
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))
import popularity as source

WIKI_API = "https://en.wikipedia.org/w/api.php"


def repair_redirects(clubs, journal, client, months, max_aliases=16):
    """Use one complete, verified redirect series when the sitelink is partial.

    Choose the highest median among bounded, verified aliases. Never add their
    views together or manufacture missing buckets. Journal every source result.
    """
    errors = 0
    for qid in clubs:
        record = journal.records.get(qid, {})
        coverage, views = record.get("coverage", {}), record.get("views", {})
        title = coverage.get("enwiki")
        if (not title or not source.fresh(coverage) or not source.retry_ready(record, "views")
                or all(month in views.get("months", {}) for month in months)):
            continue
        scan = record.get("redirect_scan", {})
        try:
            if scan.get("policy") != 3 or scan.get("sitelink_title") != title or not source.fresh(scan):
                payload = client.get(WIKI_API, {"action": "query", "format": "json", "titles": title,
                    "redirects": 1, "prop": "redirects|pageprops", "ppprop": "wikibase_item",
                    "rdnamespace": 0, "rdlimit": 500, "maxage": 3600, "smaxage": 3600})
                pages = list(payload.get("query", {}).get("pages", {}).values())
                if len(pages) != 1 or pages[0].get("pageprops", {}).get("wikibase_item") != qid:
                    raise ValueError("Redirect target does not identify the requested club QID")
                page = pages[0]
                # The API returns older redirects first. Recent article moves
                # can otherwise fall outside the bounded readership requests.
                redirects = sorted((r for r in page.get("redirects", []) if r.get("ns") == 0),
                    key=lambda r: (r["title"] != clubs[qid].get("name"), -r.get("pageid", 0)))
                aliases = [page["title"], *[r["title"] for r in redirects]]
                aliases = [t for t in dict.fromkeys(aliases) if t != title][:max_aliases]
                scan = {"policy": 3, "fetched_at": source.utc_now(), "sitelink_title": title,
                        "resolved_title": page["title"], "qid": qid, "aliases": aliases, "done": False}
                record["redirect_scan"] = scan
                journal.put(qid, record)
            if scan.get("done"):
                continue
            observations = record.setdefault("redirect_views", {})
            for alias in scan["aliases"]:
                cached = observations.get(alias, {})
                if cached.get("months_window") == months and source.fresh(cached):
                    continue
                # Request the full measured window for each alias, including zeros
                # only when the API actually reports them.
                year, month = map(int, months[-1].split("-"))
                start = months[0].replace("-", "") + "01"
                end = months[-1].replace("-", "") + str(calendar.monthrange(year, month)[1])
                url = f"{source.VIEWS_API}/en.wikipedia.org/all-access/user/{quote(alias.replace(' ', '_'), safe='')}/monthly/{start}/{end}"
                data = client.get(url, missing_ok=True)
                observations[alias] = {"months": source.parse_views(data, alias, months),
                    "months_window": months, "fetched_at": source.utc_now()}
                journal.put(qid, record)
            complete = [(alias, observations[alias]) for alias in scan["aliases"]
                        if all(month in observations[alias]["months"] for month in months)]
            complete.sort(key=lambda item: (
                statistics.median(item[1]["months"][m] for m in months),
                sum(item[1]["months"][m] for m in months), item[0]), reverse=True)
            for alias, best in complete:
                # Check candidates in traffic order; an abbreviation without a
                # move must not hide a genuine historical title below it.
                proof = best.get("move_verification", {})
                if proof.get("months_window") != months or not source.fresh(proof):
                    moves = client.get(WIKI_API, {"action": "query", "format": "json", "list": "logevents",
                        "letype": "move", "letitle": alias, "leprop": "title|timestamp|details", "lelimit": 50,
                        "maxage": 3600, "smaxage": 3600})
                    targets = set(scan["aliases"]) | {scan["resolved_title"]}
                    verified = [event["timestamp"] for event in moves.get("query", {}).get("logevents", [])
                                if event.get("title") == alias
                                and event.get("params", {}).get("target_title") in targets
                                and source.age_days(event.get("timestamp")) is not None
                                and months[0] <= event["timestamp"][:7]]
                    proof = {"fetched_at": source.utc_now(), "months_window": months,
                             "moved_at": max(verified) if verified else None}
                    best["move_verification"] = proof
                    journal.put(qid, record)
                if not proof["moved_at"]:
                    continue
                record["views"] = {"title": alias, "months": best["months"], "attempted_window": months,
                    "attempted_on": source.utc_now()[:10], "fetched_at": best["fetched_at"], "status": "complete",
                    "title_mode": "verified_redirect", "sitelink_title": title,
                    "resolved_title": scan["resolved_title"], "verified_alias_qid": qid,
                    "alias_checked_at": min(scan["fetched_at"], proof["fetched_at"]), "alias_move_at": proof["moved_at"]}
                record.pop("views_error", None)
                print(f"club recognition: recovered a complete verified redirect series for {qid}: {alias}", flush=True)
                break
            scan["done"] = True
            journal.put(qid, record)
        except source.BudgetExhausted:
            return errors, True
        except (source.requests.RequestException, ValueError, KeyError, TypeError) as exc:
            errors += 1
            record["views_error"] = {"at": source.utc_now(), "type": type(exc).__name__, "message": str(exc)[:300]}
            journal.put(qid, record)
            print(f"club recognition: redirect repair failed for {qid}: {exc}", flush=True)
    return errors, False


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
        if not stopped:
            extra_errors, stopped = repair_redirects(clubs, journal, client, months)
            errors += extra_errors
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
