#!/usr/bin/env bash
# Publishes the plugin to the wordpress.org Plugin Directory over SVN.
#
#   wporg-svn.sh release <plugin-dir>   commit a version to trunk and tags/<version>, once
#   wporg-svn.sh listing <plugin-dir>   sync readme.txt and the listing art, nothing else
#
# <plugin-dir> is the plugin as a site receives it. For `release` that is the unpacked release
# zip, so the directory and the GitHub Release serve the same bytes. For `listing` only its
# readme.txt is read. The listing art always comes from ../.wordpress-org beside this script.
#
# The directory installs whatever readme.txt's `Stable tag:` names under tags/, and a tag is
# never rewritten here: a version that is already in tags/ is skipped by `release`. Only the
# readme inside it may change afterwards, which is what `listing` is for.
#
# Env: SVN_USERNAME and SVN_PASSWORD. DRY_RUN=1 prints what would be committed and stops, and
# needs no credentials, because the directory's SVN is readable anonymously.
set -euo pipefail

SLUG=naulon
SVN_URL="https://plugins.svn.wordpress.org/${SLUG}"
ASSETS_DIR="$(cd "$(dirname "$0")/../.wordpress-org" && pwd)"

die() { echo "::error::$*" >&2; exit 1; }

mode="${1:-}"
src="${2:-}"
[ "$mode" = release ] || [ "$mode" = listing ] || die "usage: $0 release|listing <plugin-dir>"
[ -f "$src/naulon.php" ] && [ -f "$src/readme.txt" ] || die "$src is not the plugin: no naulon.php or readme.txt"
src="$(cd "$src" && pwd)"

if [ "${DRY_RUN:-}" != 1 ]; then
	[ -n "${SVN_USERNAME:-}" ] || die "SVN_USERNAME is not set"
	[ -n "${SVN_PASSWORD:-}" ] || die "SVN_PASSWORD is not set"
fi

header_version() { sed -n 's/^[[:space:]]*\*[[:space:]]*Version:[[:space:]]*//p' "$1" | head -1 | tr -d '[:space:]'; }
stable_tag() { sed -n 's/^Stable tag:[[:space:]]*//p' "$1" | head -1 | tr -d '[:space:]'; }

version="$(header_version "$src/naulon.php")"
stable="$(stable_tag "$src/readme.txt")"
[ -n "$stable" ] || die "readme.txt has no Stable tag"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
svn checkout -q --depth immediates "$SVN_URL" "$work"
cd "$work"
svn update -q --set-depth infinity trunk assets
svn update -q --set-depth immediates tags

# The directory accepts these names and nothing else in assets/: banners and screenshots as PNG
# or JPG, icons as PNG, JPG, GIF or SVG. Anything else in .wordpress-org is source art, not a
# listing asset, and is removed from SVN if it ever got there.
sync_assets() {
	rsync -rc --delete --delete-excluded \
		--include='/banner-772x250.png' --include='/banner-772x250.jpg' \
		--include='/banner-1544x500.png' --include='/banner-1544x500.jpg' \
		--include='/icon-128x128.png' --include='/icon-128x128.jpg' --include='/icon-128x128.gif' \
		--include='/icon-256x256.png' --include='/icon-256x256.jpg' --include='/icon-256x256.gif' \
		--include='/icon.svg' \
		--include='/screenshot-*.png' --include='/screenshot-*.jpg' \
		--exclude='*' \
		"$ASSETS_DIR/" assets/
}

# Schedule every add and delete, so the commit matches the files on disk exactly.
stage() {
	svn add -q --force .
	svn status | sed -n 's/^![[:space:]]*//p' | while IFS= read -r gone; do svn rm -q "${gone}@"; done
}

# svn types a binary file application/octet-stream, which makes a screenshot download instead of
# opening. An SVG is text to svn, so it gets no type and needs none.
set_mime_types() {
	local f type
	for f in assets/*; do
		[ -f "$f" ] || continue
		case "$f" in
			*.png) type=image/png ;;
			*.jpg) type=image/jpeg ;;
			*.gif) type=image/gif ;;
			*) continue ;;
		esac
		svn propset -q svn:mime-type "$type" "$f"
	done
}

commit() {
	if [ -z "$(svn status)" ]; then
		echo "nothing to commit: the directory already matches"
		return
	fi
	svn status
	if [ "${DRY_RUN:-}" = 1 ]; then
		echo "DRY_RUN=1: stopping before the commit"
		return
	fi
	printf '%s' "$SVN_PASSWORD" | svn commit -q -m "$1" \
		--non-interactive --no-auth-cache --username "$SVN_USERNAME" --password-from-stdin
	echo "committed: $1"
}

source_ref="${GITHUB_REPOSITORY:-local}@${GITHUB_SHA:-$(git -C "$ASSETS_DIR" rev-parse HEAD 2>/dev/null || echo unknown)}"

case "$mode" in
	release)
		[ "$version" = "$stable" ] || die "Version: $version and Stable tag: $stable disagree; the directory would serve a tag that is not this build"
		if [ -d "tags/$version" ]; then
			echo "$SLUG $version is already in tags/; a published version is never rewritten"
			exit 0
		fi
		rsync -rc --delete "$src/" trunk/
		sync_assets
		stage
		svn copy -q trunk "tags/$version"
		set_mime_types
		commit "Release $version from $source_ref"
		;;
	listing)
		sync_assets
		# A readme whose Stable tag is not published yet describes a release that has not happened;
		# that release carries it. Only the readme of a published version is updated in place.
		if [ -d "tags/$stable" ]; then
			svn update -q --set-depth files "tags/$stable"
			published="$(header_version "tags/$stable/naulon.php")"
			[ "$published" = "$stable" ] || die "tags/$stable holds Version: $published"
			cp "$src/readme.txt" trunk/readme.txt
			cp "$src/readme.txt" "tags/$stable/readme.txt"
		else
			echo "Stable tag $stable is not in tags/ yet: syncing the listing art only"
		fi
		stage
		set_mime_types
		commit "Update the readme and listing art from $source_ref"
		;;
esac
