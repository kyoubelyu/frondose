#!/usr/bin/env bash
# P-38: one-time backfill of GitHub Releases for v0.4.26..v0.4.34.
# Releases never existed because .github/workflows/release.yml was gitignored
# until P-38. v0.4.35+ auto-release via the now-tracked workflow.
#
# PREREQUISITE: a valid GitHub token. The operator must first rotate GH_TOKEN
# (the .env token returns "Bad credentials") and `gh auth login`, then confirm
# the tags are on the remote:  git ls-remote --tags origin | grep 'v0\.4\.'
#
# Idempotent: a tag that already has a Release is skipped, not a hard error.
set -uo pipefail

TAGS="v0.4.26 v0.4.27 v0.4.28 v0.4.29 v0.4.30 v0.4.31 v0.4.32 v0.4.33 v0.4.34"

for tag in $TAGS; do
  if gh release view "$tag" >/dev/null 2>&1; then
    echo "SKIP  $tag (Release already exists)"
    continue
  fi
  body=$(git tag -l --format='%(contents)' "$tag")
  if [ -z "${body// /}" ]; then
    body=$(git log -1 --pretty=%B "$tag")
  fi
  if printf '%s\n\n---\nBackfilled by P-38 (release.yml was gitignored before v0.4.35).\n' "$body" \
       | gh release create "$tag" --title "$tag" --notes-file -; then
    echo "OK    $tag"
  else
    echo "FAIL  $tag" >&2
  fi
done
echo "Backfill complete. Verify: gh release list"
