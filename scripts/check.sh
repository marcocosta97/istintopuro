#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for file in site/*.js scripts/*.js; do
  node --check "$file"
done
python3 -m unittest discover -s tests
node --test --test-concurrency=1 tests/*.test.js
VALIDATE_PUBLISHED_ONLY=1 python3 pipeline/pipeline.py validate
node scripts/quiz-schedule.js --check
