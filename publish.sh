#!/bin/bash
# Push repo contents to origin/main as a single commit with no history.
# The local repo keeps its full history. The remote always shows one commit.
set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)

git checkout --orphan _publish
git add -A
git commit -m "Persona Ranker — coding exercise"
git push origin _publish:main --force
git checkout "$BRANCH"
git branch -D _publish

echo "Published to origin/main (single commit, no history)"
