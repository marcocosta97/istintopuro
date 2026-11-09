#!/usr/bin/env python3
"""Collect recognition signals for core quiz candidates, without changing scoring.

State and audit output live in data/popularity, separately from published assets.
Each successful source result is journalled before the next request, so bounded
runs can gradually cover the dataset. Run with --help for limits and smoke tests.
"""
import argparse
import calendar
import copy
from collections import Counter
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
from pathlib import Path
import statistics
import time
from urllib.parse import quote, urlsplit

import requests

ROOT = Path(__file__).resolve().parents[1]
UA = "istintopuro-pipeline/0.1 (mcosta97@proton.me)"
WD_API = "https://www.wikidata.org/w/api.php"
VIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article"
VERSION = 1
REFRESH_DAYS = 90
RETRY_DAYS = 7


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def age_days(timestamp):
    if not isinstance(timestamp, str):
        return None
    try:
        observed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        now = datetime.fromisoformat(utc_now())
        age = (now - observed).total_seconds() / 86400
        return age if age >= 0 else None
    except (TypeError, ValueError):
        return None


def fresh(signal, days=REFRESH_DAYS):
    age = age_days((signal or {}).get("fetched_at"))
    return age is not None and age < days


def fresh_views(signal, days=REFRESH_DAYS):
    return fresh(signal, days) and (signal.get("title_mode") != "verified_redirect"
        or fresh({"fetched_at": signal.get("alias_checked_at")}, days))


def matches_title(qid, views, title):
    return bool(title and (views.get("title") == title or (
        views.get("title_mode") == "verified_redirect" and views.get("verified_alias_qid") == qid
        and views.get("sitelink_title") == title)))


def retry_ready(record, stage):
    age = age_days(record.get(stage + "_error", {}).get("at"))
    # A failed coverage batch reflects the shared API, not 50 broken players.
    # Let a later maintenance run retry it without quarantining them for a week.
    retry_days = 15 / (24 * 60) if stage == "coverage" else RETRY_DAYS
    return age is None or age >= retry_days


def month_window(through=None, today=None):
    today = today or date.fromisoformat(utc_now()[:10])
    last = today.year * 12 + today.month - 2
    if through:
        end = date.fromisoformat(through + "-01")
        last = end.year * 12 + end.month - 1
        if end >= today.replace(day=1):
            raise ValueError("--through must be a complete past month")
    return [f"{i // 12:04d}-{i % 12 + 1:02d}" for i in range(last - 11, last + 1)]


def candidates(site_data):
    """Use the emitted core, including overlay clubs; omit zero-app registrations."""
    index = json.loads((site_data / "index.json").read_text())
    links = Counter()
    for deltas, apps in zip(index["postings"], index["apps"]):
        pid = 0
        for delta, appearances in zip(deltas, apps):
            pid += delta
            if appearances != 0:
                links[pid] += 1
    wanted = {pid for pid, count in links.items() if count >= 2}
    result, found = {}, set()
    for shard in range(index["nshards"]):
        rows = json.loads((site_data / "career" / f"{shard}.json").read_text())
        for key, row in rows.items():
            pid = int(key)
            if pid in wanted:
                qid = f"Q{row[0]}"
                result[qid] = {"name": index["names"][pid], "club_count": links[pid]}
                found.add(pid)
    if found != wanted:
        raise ValueError("Core career shards are missing quiz candidates")
    return index["built"], dict(sorted(result.items(), key=lambda x: int(x[0][1:])))


def language_coverage(entity):
    if not isinstance(entity, dict):
        raise ValueError("Invalid Wikidata entity")
    if "missing" in entity:
        return {"status": "missing_entity", "count": None, "languages": [], "enwiki": None}
    links = entity.get("sitelinks")
    if not isinstance(links, dict):
        raise ValueError("Wikidata entity has no sitelinks object")
    languages, title = set(), None
    for link in links.values():
        if (not isinstance(link, dict) or not isinstance(link.get("url"), str)
                or not isinstance(link.get("title"), str) or not link["title"]):
            raise ValueError("Invalid Wikidata sitelink")
        host = urlsplit(link["url"]).hostname or ""
        if not host:
            raise ValueError("Wikidata sitelink has no hostname")
        if host.endswith(".wikipedia.org"):
            languages.add(host.removesuffix(".wikipedia.org"))
            if host == "en.wikipedia.org":
                title = link["title"]
    return {"status": "available", "count": len(languages),
            "languages": sorted(languages), "enwiki": title}


def parse_views(payload, title, months):
    """Missing buckets stay absent, including an empty or 404 response."""
    if payload is None:
        return {}
    items = payload.get("items")
    if not isinstance(items, list):
        raise ValueError("Pageviews response has no items array")
    result = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid pageviews bucket")
        stamp = item.get("timestamp", "")
        if not isinstance(stamp, str):
            raise ValueError("Invalid pageviews timestamp")
        month = f"{stamp[:4]}-{stamp[4:6]}"
        views = item.get("views")
        if (month not in months or stamp != month.replace("-", "") + "0100"
                or type(views) is not int or views < 0 or month in result
                or item.get("agent") != "user" or item.get("access") != "all-access"
                or item.get("granularity") != "monthly"
                or item.get("project") != "en.wikipedia"
                or not isinstance(item.get("article"), str)
                or item.get("article", "").replace(" ", "_") != title.replace(" ", "_")):
            raise ValueError("Unexpected pageviews bucket")
        result[month] = views
    return result


def atomic_json(path, value, compact=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=None if compact else 2,
                              separators=(",", ":") if compact else None) + "\n")
    tmp.replace(path)


class Journal:
    def __init__(self, path):
        self.path, self.records = path, {}
        if path.exists():
            lines = path.read_text().splitlines(keepends=True)
            for i, line in enumerate(lines):
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    if i == len(lines) - 1 and not line.endswith("\n"):
                        break  # A killed write can leave an incomplete final line.
                    raise
                if row.get("version") != VERSION:
                    raise ValueError("Unsupported popularity state version")
                self.records[row["qid"]] = row["record"]
        self.compact()

    def compact(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        with tmp.open("w") as out:
            for qid, record in self.records.items():
                out.write(json.dumps({"version": VERSION, "qid": qid, "record": record},
                                     ensure_ascii=False) + "\n")
        tmp.replace(self.path)

    def put(self, qid, record):
        self.records[qid] = record
        with self.path.open("a") as out:
            out.write(json.dumps({"version": VERSION, "qid": qid, "record": record},
                                 ensure_ascii=False) + "\n")


class BudgetExhausted(Exception):
    pass


class Client:
    def __init__(self, max_requests, max_seconds):
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": UA, "Accept": "application/json"})
        self.count, self.maximum = 0, max_requests
        self.deadline = time.monotonic() + max_seconds

    def pause(self, seconds):
        if time.monotonic() + seconds >= self.deadline:
            raise BudgetExhausted()
        time.sleep(seconds)

    def get(self, url, params=None, missing_ok=False):
        last_error = None
        attempts = 5
        for attempt in range(attempts):
            if self.count >= self.maximum or time.monotonic() >= self.deadline:
                if last_error is not None:
                    raise last_error
                raise BudgetExhausted()
            if self.count:
                try:
                    self.pause(.2)  # Serial requests, with a small additional courtesy gap.
                except BudgetExhausted:
                    if last_error is not None:
                        raise last_error
                    raise
            self.count += 1
            response = None
            try:
                response = self.session.get(url, params=params,
                                            timeout=max(.1, min(30, self.deadline - time.monotonic())))
                if missing_ok and response.status_code == 404:
                    return None
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Wikimedia returned an invalid JSON object")
                if "error" in payload:
                    detail = json.dumps(payload["error"], ensure_ascii=False)[:300]
                    raise ValueError(f"Wikimedia API error: {detail}")
                return payload
            except (requests.RequestException, ValueError) as exc:
                last_error = exc
                if attempt == attempts - 1 or self.count >= self.maximum:
                    raise
                # MediaWiki can report maxlag with HTTP 200. Give upstream load
                # time to clear, even when Retry-After repeats a short minimum.
                delay = 5 * 2 ** attempt
                if response is not None and response.headers.get("Retry-After"):
                    retry = response.headers["Retry-After"]
                    try:
                        delay = max(delay, float(retry))
                    except ValueError:
                        try:
                            delay = max(delay, parsedate_to_datetime(retry).timestamp() - time.time())
                        except (TypeError, ValueError, OverflowError):
                            pass
                try:
                    print(f"popularity: request failed ({attempt + 1}/{attempts}): "
                          f"{str(exc)[:300]}; retrying in {delay:g}s", flush=True)
                    self.pause(delay)
                except BudgetExhausted:
                    raise last_error


def collect(players, journal, client, months, refresh_days=REFRESH_DAYS, priority_qids=()):
    today = utc_now()[:10]
    period = today[:7]
    errors, stopped, consecutive = 0, False, 0
    priority = set(priority_qids)

    def failure(qids, stage, exc):
        nonlocal errors, consecutive
        errors += len(qids)
        consecutive += 1
        message = str(exc)[:300]
        print(f"popularity: {stage} failed for {qids[0]} ({type(exc).__name__}): {message}", flush=True)
        for qid in qids:
            record = journal.records.get(qid, {})
            record[stage + "_error"] = {"at": utc_now(), "type": type(exc).__name__, "message": message}
            journal.put(qid, record)

    try:
        stale = [qid for qid in players
                 if not fresh(journal.records.get(qid, {}).get("coverage"), refresh_days)
                 and retry_ready(journal.records.get(qid, {}), "coverage")]
        stale.sort(key=lambda qid: (qid not in priority,
            journal.records.get(qid, {}).get("coverage", {}).get("fetched_at", "")))
        for start in range(0, len(stale), 50):
            batch = stale[start:start + 50]
            try:
                # These cacheable entity reads do not use WDQS. Its replication
                # lag also feeds maxlag, which can reject healthy sitelink reads.
                payload = client.get(WD_API, {"action": "wbgetentities", "ids": "|".join(batch),
                                             "props": "sitelinks/urls", "format": "json",
                                             "maxage": 3600, "smaxage": 3600})
                # Validate the whole batch before checkpointing any of it.
                parsed = {qid: language_coverage(payload["entities"][qid]) for qid in batch}
                for qid, coverage in parsed.items():
                    coverage.update(period=period, fetched_at=utc_now())
                    record = journal.records.get(qid, {})
                    record["coverage"] = coverage
                    record.pop("coverage_error", None)
                    journal.put(qid, record)
                consecutive = 0
                if start % 1000 == 0 or start + 50 >= len(stale):
                    print(f"popularity: language coverage {min(start + 50, len(stale))}/{len(stale)}", flush=True)
            except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
                failure(batch, "coverage", exc)
                if consecutive >= 3:
                    break
        if consecutive >= 3:
            return errors, stopped

        def last_attempt(qid):
            record = journal.records.get(qid, {})
            return max(record.get("views", {}).get("fetched_at", ""),
                       record.get("views_error", {}).get("at", ""))

        # Within each priority group, try unattempted players then the oldest
        # attempts, so repeated 404s cannot consume every maintenance budget.
        for index, qid in enumerate(sorted(players, key=lambda qid: (qid not in priority, last_attempt(qid)))):
            record = journal.records.get(qid, {})
            coverage = record.get("coverage", {})
            # Never fetch a potentially renamed article using stale metadata.
            if not fresh(coverage, refresh_days) or not coverage.get("enwiki"):
                continue
            title = coverage["enwiki"]
            views = record.get("views", {})
            if matches_title(qid, views, title) and fresh_views(views, refresh_days):
                continue
            if (views.get("title") != title or (views.get("title_mode") == "verified_redirect"
                    and not fresh_views(views, refresh_days))):
                views = {"title": title, "months": {}}
            if fresh(views, refresh_days) or not retry_ready(record, "views"):
                continue
            cached = views.get("months", {})
            missing = [month for month in months if month not in cached]
            if not missing or (views.get("attempted_on") == today
                               and views.get("attempted_window") == months):
                continue
            # One request backfills a new player, or fills only missing months on rollover.
            start = missing[0].replace("-", "") + "01"
            y, m = map(int, missing[-1].split("-"))
            end = f"{y:04d}{m:02d}{calendar.monthrange(y, m)[1]:02d}"
            url = f"{VIEWS_API}/en.wikipedia.org/all-access/user/{quote(title.replace(' ', '_'), safe='')}/monthly/{start}/{end}"
            try:
                payload = client.get(url, missing_ok=True)
                incoming = parse_views(payload, title, months)
                views["months"] = {month: cached[month] for month in months if month in cached}
                views["months"].update(incoming)
                views.update(attempted_on=today, attempted_window=months, fetched_at=utc_now(),
                             status="unavailable" if payload is None else "partial")
                record["views"] = views
                record.pop("views_error", None)
                journal.put(qid, record)
                consecutive = 0
                if index % 200 == 0:
                    print(f"popularity: checked readership for {index + 1}/{len(players)} candidates", flush=True)
            except (requests.RequestException, ValueError, KeyError, TypeError) as exc:
                failure([qid], "views", exc)
                if consecutive >= 3:
                    break
    except BudgetExhausted:
        stopped = True
    return errors, stopped


def audit(players, journal, months, built, requests_made, errors, stopped, refresh_days=REFRESH_DAYS):
    rows, summary = {}, Counter()
    for qid, player in players.items():
        record = journal.records.get(qid, {})
        coverage = record.get("coverage")
        current = fresh(coverage, refresh_days)
        summary["current_language_coverage"] += int(current and coverage["count"] is not None)
        stored = record.get("views", {})
        title = coverage.get("enwiki") if coverage else None
        matching = matches_title(qid, stored, title)
        cached = stored.get("months", {}) if matching else {}
        measured = stored.get("attempted_window", months) if matching else months
        monthly = [[month, cached.get(month)] for month in measured]
        observed = sum(n is not None for _, n in monthly)
        if coverage and current and coverage["status"] == "available" and not title:
            status = "no_article"
        elif observed == 12:
            status = "complete"
        elif observed:
            status = "partial"
        else:
            status = stored.get("status", "pending") if matching else "pending"
        summary["pageviews_" + status] += 1
        summary["pageviews_fresh"] += int(matching and fresh_views(stored, refresh_days))
        values = [n for _, n in monthly if n is not None]
        rows[qid] = {**player, "language_coverage": {**coverage, "current": current} if coverage else None,
                     "pageviews": {"title": stored.get("title", title) if matching else title, "status": status, "monthly": monthly,
                                   "through": measured[-1], "current": matching and fresh_views(stored, refresh_days),
                                   "observed_months": observed,
                                   "total_views": sum(values) if status == "complete" else None,
                                   "median_monthly_views": statistics.median(values) if status == "complete" else None,
                                   "fetched_at": stored.get("fetched_at") if matching else None,
                                   **{key: stored[key] for key in ("title_mode", "verified_alias_qid", "sitelink_title", "alias_checked_at", "alias_move_at", "resolved_title")
                                      if matching and key in stored}},
                     "errors": {stage: record[stage + "_error"] for stage in ("coverage", "views")
                                if stage + "_error" in record}}
    return {"version": VERSION, "generated_at": utc_now(), "dataset_built": built,
            "refresh_days": refresh_days,
            "through": months[-1], "months": months, "scope": "core players with two nonzero-or-unknown club links",
            "pageviews_source": {"project": "en.wikipedia.org", "access": "all-access", "agent": "user"},
            "candidate_count": len(players), "summary": dict(summary),
            "run": {"requests": requests_made, "errors": errors, "budget_exhausted": stopped}, "players": rows}


def validate_snapshot(snapshot):
    """Validate saved observations before they can replace a published snapshot."""
    if (not isinstance(snapshot, dict) or snapshot.get("version") != VERSION
            or snapshot.get("kind") != "recognition-snapshot"
            or not isinstance(snapshot.get("players"), dict)
            or snapshot.get("candidate_count") != len(snapshot["players"])
            or age_days(snapshot.get("generated_at")) is None):
        raise ValueError("Invalid recognition snapshot header")
    for qid, row in snapshot["players"].items():
        if (not isinstance(qid, str) or not qid.startswith("Q") or not qid[1:].isdigit()
                or not isinstance(row, dict)):
            raise ValueError("Invalid recognition player")
        coverage = row.get("language_coverage")
        if coverage is not None:
            count, languages = coverage.get("count"), coverage.get("languages")
            if (not isinstance(languages, list) or any(not isinstance(x, str) for x in languages)
                    or (count is not None and (type(count) is not int or count != len(set(languages))))
                    or age_days(coverage.get("fetched_at")) is None):
                raise ValueError(f"Invalid language coverage for {qid}")
        views = row.get("pageviews", {})
        if views.get("title_mode") == "verified_redirect" and (
                views.get("verified_alias_qid") != qid or not coverage
                or views.get("sitelink_title") != coverage.get("enwiki")
                or age_days(views.get("alias_checked_at")) is None
                or age_days(views.get("alias_move_at")) is None):
            raise ValueError(f"Invalid readership redirect identity for {qid}")
        monthly = views.get("monthly")
        if not isinstance(monthly, list) or len(monthly) != 12:
            raise ValueError(f"Invalid readership window for {qid}")
        labels, values = [], []
        for bucket in monthly:
            if (not isinstance(bucket, list) or len(bucket) != 2
                    or (bucket[1] is not None and (type(bucket[1]) is not int or bucket[1] < 0))):
                raise ValueError(f"Invalid readership bucket for {qid}")
            date.fromisoformat(bucket[0] + "-01")
            labels.append(bucket[0])
            values.append(bucket[1])
        if labels != month_window(labels[-1]) or views.get("through") != labels[-1]:
            raise ValueError(f"Nonconsecutive readership window for {qid}")
        complete = all(value is not None for value in values)
        if views.get("status") == "complete":
            if (not complete or views.get("total_views") != sum(values)
                    or views.get("median_monthly_views") != statistics.median(values)
                    or age_days(views.get("fetched_at")) is None):
                raise ValueError(f"Invalid readership totals for {qid}")
        elif views.get("total_views") is not None or views.get("median_monthly_views") is not None:
            raise ValueError(f"Incomplete readership has totals for {qid}")
    return snapshot


def make_snapshot(report, previous=None):
    snapshot = copy.deepcopy(report)
    snapshot["kind"] = "recognition-snapshot"
    for qid, row in snapshot["players"].items():
        old = (previous or {}).get("players", {}).get(qid, {})
        if (row["pageviews"]["status"] != "complete"
                and old.get("pageviews", {}).get("status") == "complete"):
            row["pageviews"] = copy.deepcopy(old["pageviews"])
            row["pageviews"]["current"] = fresh_views(row["pageviews"], snapshot["refresh_days"])
        if ((row["language_coverage"] or {}).get("count") is None
                and (old.get("language_coverage") or {}).get("count") is not None):
            row["language_coverage"] = copy.deepcopy(old["language_coverage"])
            row["language_coverage"]["current"] = fresh(row["language_coverage"], snapshot["refresh_days"])
    # The audit summary describes attempts; recompute the snapshot's actual coverage.
    counts = Counter()
    for row in snapshot["players"].values():
        coverage, views = row["language_coverage"], row["pageviews"]
        counts["current_language_coverage"] += int(bool(coverage and coverage["current"] and coverage["count"] is not None))
        counts["pageviews_" + views["status"]] += 1
        counts["pageviews_fresh"] += int(views["current"])
    snapshot["summary"] = dict(counts)
    return validate_snapshot(snapshot)


def publish_snapshot(source, output):
    if not source.exists():
        print("recognition: no new snapshot; keeping published signals", flush=True)
        return
    try:
        snapshot = validate_snapshot(json.loads(source.read_text()))
    except (ValueError, KeyError, TypeError, AttributeError) as exc:
        print(f"recognition: keeping published signals after invalid snapshot: {exc}", flush=True)
        return
    if output.exists():
        try:
            previous = validate_snapshot(json.loads(output.read_text()))
        except (ValueError, KeyError, TypeError, AttributeError):
            previous = None
        if previous and (datetime.fromisoformat(previous["generated_at"].replace("Z", "+00:00"))
                         > datetime.fromisoformat(snapshot["generated_at"].replace("Z", "+00:00"))):
            print("recognition: keeping newer published snapshot", flush=True)
            return
    atomic_json(output, snapshot, compact=True)
    print(f"recognition: reused {len(snapshot['players'])} player observations without source requests", flush=True)


def positive_int(value):
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def sample_players(source, site_data, players):
    sample = json.loads(source.read_text())
    rows = sample.get("players")
    if (sample.get("version") != 1 or sample.get("kind") != "recognition-calibration-sample"
            or not isinstance(rows, list) or not rows
            or sample.get("indexFileDigest") != hashlib.sha256((site_data / "index.json").read_bytes()).hexdigest()):
        raise ValueError("Calibration sample is invalid or belongs to a different core index")
    qids = [row.get("qid") for row in rows if isinstance(row, dict)]
    if len(qids) != len(rows) or len(set(qids)) != len(qids) or any(qid not in players for qid in qids):
        raise ValueError("Calibration sample must contain unique core candidate QIDs")
    return {qid: players[qid] for qid in qids}


def priority_qids(source, site_data, players):
    priority = json.loads(source.read_text())
    qids = priority.get("qids")
    if (priority.get("version") != 1 or priority.get("kind") != "quiz-recognition-priority"
            or priority.get("indexFileDigest") != hashlib.sha256((site_data / "index.json").read_bytes()).hexdigest()
            or not isinstance(qids, list) or any(not isinstance(q, str) for q in qids)
            or len(set(qids)) != len(qids) or any(q not in players for q in qids)):
        raise ValueError("Invalid quiz recognition priority list or mismatched core index")
    return qids


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site-data", type=Path, default=ROOT / "site/data")
    parser.add_argument("--state", type=Path, default=ROOT / "data/popularity/state.jsonl")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--snapshot", type=Path)
    parser.add_argument("--publish", action="store_true", help="reuse a validated snapshot at --output, without collection")
    parser.add_argument("--refresh-days", type=positive_int, default=REFRESH_DAYS)
    parser.add_argument("--through", help="last complete month, YYYY-MM (default: previous UTC month)")
    parser.add_argument("--max-requests", type=positive_int, default=6000)
    parser.add_argument("--max-seconds", type=positive_int, default=3000)
    parser.add_argument("--limit", type=positive_int, help="collect a deterministic subset for a smoke test")
    parser.add_argument("--qids", help="comma-separated core candidate QIDs for a targeted smoke test")
    parser.add_argument("--priority", type=Path, help="prioritise likely published quiz answers before the ordinary backfill")
    parser.add_argument("--sample", type=Path, help="collect a frozen calibration sample; outputs stay separate from release snapshots")
    args = parser.parse_args(argv)
    if args.sample and (args.qids or args.limit or args.publish):
        parser.error("--sample cannot be combined with --qids, --limit or --publish")
    directory = ROOT / ("data/recognition-calibration" if args.sample else "data/popularity")
    args.output = args.output or directory / "metrics.json"
    args.snapshot = args.snapshot or directory / "snapshot.json"
    if args.sample and (args.snapshot.resolve() == (ROOT / "data/popularity/snapshot.json").resolve()
                        or (ROOT / "site").resolve() in args.snapshot.resolve().parents
                        or (ROOT / "site").resolve() in args.output.resolve().parents):
        parser.error("calibration outputs must be separate from production snapshots and published assets")
    if args.publish:
        publish_snapshot(args.snapshot, args.output)
        return 0
    months = month_window(args.through)
    built, players = candidates(args.site_data)
    priority = priority_qids(args.priority, args.site_data, players) if args.priority else []
    if args.sample:
        players = sample_players(args.sample, args.site_data, players)
    if args.qids:
        wanted = set(args.qids.split(","))
        if wanted - players.keys():
            parser.error("--qids must name core quiz candidates")
        players = {qid: row for qid, row in players.items() if qid in wanted}
    if args.limit:
        players = dict(list(players.items())[:args.limit])
    journal = Journal(args.state)
    client = Client(args.max_requests, args.max_seconds)
    errors, stopped = 0, False
    try:
        errors, stopped = collect(players, journal, client, months, args.refresh_days, priority)
    finally:
        journal.compact()
        report = audit(players, journal, months, built, client.count, errors, stopped, args.refresh_days)
        if args.sample:
            report["scope"] = "frozen calibration sample, not the complete quiz candidate pool"
            report["sample_digest"] = hashlib.sha256(args.sample.read_bytes()).hexdigest()
        atomic_json(args.output, report)
        client.session.close()
    if (args.sample or not errors) and not args.qids and not args.limit:
        previous = validate_snapshot(json.loads(args.snapshot.read_text())) if args.snapshot.exists() else None
        atomic_json(args.snapshot, make_snapshot(report, previous), compact=True)
    print(f"popularity: {len(players)} candidates; {client.count} requests; "
          f"{report['summary']}; budget exhausted: {stopped}; errors: {errors}", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
