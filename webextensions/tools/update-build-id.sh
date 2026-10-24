#!/bin/sh
# Stamps webextensions/common/build-id.js with the commit time so that a
# stale Chrome service worker can be detected (see common/stale-code.js).
# Install once as a pre-commit hook from the repository root:
#   ln -s ../../webextensions/tools/update-build-id.sh .git/hooks/pre-commit
set -e
cd "$(git rev-parse --show-toplevel)"
file=webextensions/common/build-id.js
[ -f "$file" ] || exit 0
git diff --cached --quiet -- webextensions && exit 0
id=$(date -u +%Y%m%dT%H%M%SZ)
perl -pi -e "s/^(export const BUILD_ID = ')[^']*(';)/\${1}$id\${2}/" "$file"
git add "$file"
