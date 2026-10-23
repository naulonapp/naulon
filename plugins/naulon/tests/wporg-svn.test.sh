#!/usr/bin/env bash
# bin/wporg-svn.sh against a throwaway local repository laid out like the directory's
# (assets/, tags/, trunk/), so every branch that decides what reaches wordpress.org runs for real.
# Needs svn, svnadmin and rsync.
#
# Each assertion is single-quoted so check() evaluates it after the step it checks has run.
# shellcheck disable=SC2016,SC2034
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/../bin/wporg-svn.sh"
plugin="$here/.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

svnadmin create "$tmp/repo"
export WPORG_SVN_URL="file://$tmp/repo"
svn mkdir -q -m init "$WPORG_SVN_URL/assets" "$WPORG_SVN_URL/tags" "$WPORG_SVN_URL/trunk"
export SVN_USERNAME=test SVN_PASSWORD=test

# The listing art, plus two files the directory would not accept as assets.
export WPORG_ASSETS_DIR="$tmp/art"
mkdir -p "$WPORG_ASSETS_DIR"
cp "$plugin/.wordpress-org/icon-128x128.png" "$plugin/.wordpress-org/icon.svg" "$WPORG_ASSETS_DIR/"
echo '<svg/>' > "$WPORG_ASSETS_DIR/banner-772x250.svg"
echo 'source' > "$WPORG_ASSETS_DIR/notes.txt"

failures=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1"; failures=$((failures + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
url() { echo "$WPORG_SVN_URL/$1"; }
cat_url() { svn cat "$(url "$1")" 2>/dev/null; }

# A build of version $1, as the release zip would unpack it.
build() {
	local dir="$tmp/build-$1"
	mkdir -p "$dir/includes"
	printf '<?php\n/**\n * Plugin Name: naulon\n * Version:     %s\n */\n' "$1" > "$dir/naulon.php"
	printf '=== naulon ===\nStable tag: %s\n\n%s\n' "${2:-$1}" "${3:-readme for $1}" > "$dir/readme.txt"
	echo "<?php // $1" > "$dir/includes/a.php"
	echo "$dir"
}

head_rev() { svn info --show-item revision "$WPORG_SVN_URL"; }

# release: trunk, the tag and the listing art land in one commit
"$script" release "$(build 1.0.0)" > /dev/null
check "release puts the build in trunk" '[ "$(cat_url trunk/includes/a.php)" = "<?php // 1.0.0" ]'
check "release copies trunk to tags/<version>" '[ "$(cat_url tags/1.0.0/includes/a.php)" = "<?php // 1.0.0" ]'
check "release syncs the listing art" 'svn ls "$(url assets)" | grep -qx icon-128x128.png'
check "source art the directory rejects stays out of assets/" '[ "$(svn ls "$(url assets)" | tr "\n" " ")" = "icon-128x128.png icon.svg " ]'
check "a PNG is served as an image" '[ "$(svn propget svn:mime-type "$(url assets/icon-128x128.png)")" = image/png ]'

# release again: a published version is never rewritten
rev=$(head_rev)
other=$(build 1.0.0)
echo "<?php // changed" > "$other/includes/a.php"
"$script" release "$other" > /dev/null
check "re-releasing a published version commits nothing" '[ "$(head_rev)" = "$rev" ]'

# release with Version and Stable tag apart: refused before anything is written
if "$script" release "$(build 1.1.0 1.0.0)" > /dev/null 2>&1; then
	fail "a build whose Version and Stable tag disagree is refused"
else
	pass "a build whose Version and Stable tag disagree is refused"
fi
check "the refused build reached nothing" '[ "$(head_rev)" = "$rev" ] && ! svn ls "$(url tags/1.1.0)" > /dev/null 2>&1'

# listing: a readme for the published version updates trunk and the tag, nothing else
"$script" listing "$(build 1.0.0 1.0.0 'a clearer FAQ')" > /dev/null
check "listing updates the readme inside the published tag" 'cat_url tags/1.0.0/readme.txt | grep -q "a clearer FAQ"'
check "listing updates the trunk readme" 'cat_url trunk/readme.txt | grep -q "a clearer FAQ"'
check "listing leaves the code alone" '[ "$(cat_url trunk/includes/a.php)" = "<?php // 1.0.0" ]'

# listing ahead of a release: the readme waits for the release that carries it
rev=$(head_rev)
"$script" listing "$(build 2.0.0 2.0.0 'notes for 2.0.0')" > /dev/null
check "a readme for an unreleased version is not published" '! cat_url trunk/readme.txt | grep -q "2.0.0"'
check "with nothing else changed, nothing is committed" '[ "$(head_rev)" = "$rev" ]'

# DRY_RUN needs no credentials and commits nothing
env -u SVN_USERNAME -u SVN_PASSWORD DRY_RUN=1 "$script" release "$(build 3.0.0)" > /dev/null
check "a dry run commits nothing" '[ "$(head_rev)" = "$rev" ]'

[ "$failures" -eq 0 ] || { echo "$failures failed"; exit 1; }
echo "all passed"
