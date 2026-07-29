#!/usr/bin/env bash
# Fetch the latin woff2 subset of each brand face. Run ONCE — the files are
# committed, so the dashboard never reaches off-origin at runtime (its CSP is
# default-src 'self'). Re-run only to refresh the faces.
#
# The three faces and their roles are the published design system's
# (https://naulon.app/brand): Fraunces display-only, Hanken Grotesk for UI and
# body, JetBrains Mono for every figure. All three are SIL OFL — see OFL.txt.
set -euo pipefail
OUT="${1:-$(dirname "$0")/../src/public/fonts}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
mkdir -p "$OUT"

fetch() { # <family-spec> <outfile>
  local css url
  css=$(curl -sf -A "$UA" "https://fonts.googleapis.com/css2?family=$1&display=swap")
  # Pick the `latin` block — the one whose unicode-range starts at U+0000.
  url=$(printf '%s\n' "$css" \
    | awk '/unicode-range: U\+0000/{print prev} {if ($0 ~ /src: url\(/) prev=$0}' \
    | grep -o 'https://[^)]*\.woff2' | tail -1)
  [ -n "$url" ] || { echo "no latin subset for $1" >&2; exit 1; }
  curl -sf -o "$OUT/$2" "$url"
  printf '%-28s %s\n' "$2" "$(du -h "$OUT/$2" | cut -f1)"
}

fetch "Fraunces:opsz,wght@9..144,300..700" fraunces-latin.woff2
fetch "Hanken+Grotesk:wght@300..800"       hanken-grotesk-latin.woff2
fetch "JetBrains+Mono:wght@400..700"       jetbrains-mono-latin.woff2
