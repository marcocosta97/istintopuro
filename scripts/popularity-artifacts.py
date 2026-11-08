#!/usr/bin/env python3
"""Restore recognition state from this branch's collection workflow artifacts."""
import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import zipfile

import requests

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("popularity", ROOT / "pipeline/popularity.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
WORKFLOW = "refresh-popularity.yml"
FILES = {"checkpoint": "state.jsonl", "snapshot": "snapshot.json"}


def validate_file(path, kind, scope="players"):
    if kind == "snapshot":
        saved = json.loads(path.read_text())
        if scope == "clubs":
            if saved.get("kind") != "club-recognition-sources" or not isinstance(saved.get("clubs"), dict):
                raise ValueError("Invalid club recognition snapshot")
            saved = {**saved, "kind": "recognition-snapshot", "players": saved["clubs"],
                     "candidate_count": len(saved["clubs"])}
        P.validate_snapshot(saved)
    else:
        journal = P.Journal(path)
        for qid, record in journal.records.items():
            if (not isinstance(qid, str) or not qid.startswith("Q") or not qid[1:].isdigit()
                    or not isinstance(record, dict)):
                raise ValueError("Invalid recognition checkpoint record")


def restore(session, repo, branch, kind, destination, scope="players"):
    api = "https://api.github.com"
    base = f"{api}/repos/{repo}/actions"
    invalid = False
    # Pagination also handles manually resumed bootstrap runs and later reruns.
    page = 1
    while True:
        response = session.get(f"{base}/workflows/{WORKFLOW}/runs",
                               params={"branch": branch, "per_page": 100, "page": page}, timeout=30)
        if response.status_code == 404:
            break  # A newly added workflow has no runs yet.
        response.raise_for_status()
        runs = response.json()["workflow_runs"]
        for run in runs:
            if (run.get("head_branch") != branch
                    or (run.get("head_repository") or {}).get("full_name") != repo
                    or run.get("event") not in ("schedule", "workflow_dispatch")):
                continue
            response = session.get(f"{base}/runs/{run['id']}/artifacts", params={"per_page": 100}, timeout=30)
            response.raise_for_status()
            artifacts = sorted(response.json()["artifacts"], key=lambda a: a["created_at"], reverse=True)
            prefix = f"quiz-{'club-' if scope == 'clubs' else ''}recognition-{kind}-v1-"
            for artifact in artifacts:
                if artifact.get("expired") or not artifact["name"].startswith(prefix):
                    continue
                response = session.get(f"{base}/artifacts/{artifact['id']}/zip", timeout=60)
                if response.status_code in (404, 410):
                    continue  # Expired between listing and downloading.
                response.raise_for_status()
                try:
                    # Read the expected file only; never extract archive paths.
                    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                        contents = archive.read(FILES[kind])
                    with tempfile.TemporaryDirectory() as tmp:
                        candidate = Path(tmp) / FILES[kind]
                        candidate.write_bytes(contents)
                        validate_file(candidate, kind, scope)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        staged = destination.with_suffix(destination.suffix + ".tmp")
                        staged.write_bytes(candidate.read_bytes())
                        staged.replace(destination)
                except (ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile) as exc:
                    invalid = True
                    print(f"recognition: skipping invalid {kind} artifact {artifact['id']}: {exc}", flush=True)
                    continue
                print(f"recognition: restored {kind} from run {run['id']}", flush=True)
                return True
        if len(runs) < 100:
            break
        page += 1
    if invalid:
        raise ValueError(f"No valid {kind} artifact could be restored; existing files retained")
    print(f"recognition: no retained {kind} artifact; existing files retained", flush=True)
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("kind", choices=FILES)
    parser.add_argument("--scope", choices=("players", "clubs"), default="players")
    parser.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--branch", default=os.environ.get("GITHUB_REF_NAME"))
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args(argv)
    if not args.repo or not args.branch:
        parser.error("--repo and --branch are required outside GitHub Actions")
    directory = "data/club-recognition" if args.scope == "clubs" else "data/popularity"
    destination = args.destination or ROOT / directory / FILES[args.kind]
    with requests.Session() as session:
        session.headers.update({"Accept": "application/vnd.github+json", "User-Agent": P.UA,
                                "X-GitHub-Api-Version": "2022-11-28"})
        token = os.environ.get("GH_TOKEN")
        if token:
            session.headers["Authorization"] = f"Bearer {token}"
        restore(session, args.repo, args.branch, args.kind, destination, args.scope)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
