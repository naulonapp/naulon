<?php
/**
 * Slug canonicalization — the known production footgun, fixed at the source.
 *
 * Production once paid the WRONG WALLET because of exactly this: a gate configured with
 * `gate_scope="site"` derived a FULL-PATH slug (`blog/my-post`), asked a credits API that only
 * answered BARE slugs (`my-post`), got a 404, and fell through to a pinned wallet. The money
 * moved; nothing errored. The lesson is that a credits endpoint must be liberal in what it
 * accepts and exact in what it refuses.
 *
 * So: the canonical slug is the URL path with the leading slash stripped (how the gate derives
 * it, and how `articlePrefixes` are expressed), the resolver accepts BOTH that and the bare
 * post slug, and an ambiguous bare slug returns nothing — 404, a free read — rather than
 * guessing which post the money was meant for. Guessing is how you pay the wrong author.
 *
 * Pure functions, no WordPress calls, so this is unit-testable without a WP bootstrap.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Slug {

	/**
	 * The canonical form of a slug or path: no scheme/host, no leading or trailing slash, no
	 * query or fragment, lower-cased, percent-decoded once.
	 *
	 * @param string $raw A slug, a path, or a full URL.
	 * @return string Canonical slug ('' when nothing usable remains).
	 */
	public static function canonicalize( $raw ) {
		if ( ! is_string( $raw ) ) {
			return '';
		}
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}

		// A full URL reduces to its path. parse_url returns false on a malformed URL; treat that
		// as "not a URL" and keep the raw value rather than throwing away the caller's input.
		if ( preg_match( '#^https?://#i', $value ) ) {
			$path  = wp_parse_url( $value, PHP_URL_PATH );
			$value = is_string( $path ) ? $path : '';
		}

		// Drop query/fragment for callers that hand us a path with either still attached.
		$value = preg_replace( '/[?#].*$/', '', $value );

		// One decode pass only. Decoding repeatedly is how %252e%252e becomes a traversal.
		$value = rawurldecode( $value );

		$value = trim( $value, "/ \t\n\r\0\x0B" );

		return strtolower( $value );
	}

	/**
	 * The bare last segment of a canonical slug — `blog/2026/my-post` → `my-post`. This is the
	 * form `%postname%` permalinks and the WP post_name column use.
	 *
	 * @param string $raw A slug, a path, or a full URL.
	 * @return string
	 */
	public static function leaf( $raw ) {
		$canonical = self::canonicalize( $raw );
		if ( '' === $canonical ) {
			return '';
		}
		$parts = explode( '/', $canonical );
		return (string) end( $parts );
	}

	/**
	 * Is this slug a plain leaf (no path segments)? A leaf is the ambiguous shape — several
	 * posts can share a `post_name` across different permalink prefixes — which is why the
	 * credits resolver refuses to guess when a leaf matches more than one post.
	 *
	 * @param string $raw A slug or path.
	 * @return bool
	 */
	public static function is_leaf( $raw ) {
		$canonical = self::canonicalize( $raw );
		return '' !== $canonical && false === strpos( $canonical, '/' );
	}

	/**
	 * Derive the article prefixes a permalink structure produces — `/blog/%postname%/` →
	 * `blog/`. Derived, never hand-entered: a hand-entered prefix that drifts from the real
	 * permalink structure reopens the same slug mismatch from a different direction.
	 *
	 * Returns an empty array for a structure with no static leading segment (plain
	 * `/%postname%/`), which correctly means "no prefix to strip".
	 *
	 * @param string $structure The permalink structure (get_option('permalink_structure')).
	 * @return string[] Prefixes, each canonical and trailing-slashed.
	 */
	public static function prefixes_from_structure( $structure ) {
		if ( ! is_string( $structure ) || '' === trim( $structure ) ) {
			return array();
		}

		$segments = explode( '/', trim( $structure, '/' ) );
		$static   = array();
		foreach ( $segments as $segment ) {
			// A rewrite tag (%postname%, %year%, …) ends the static prefix — everything after it
			// varies per post and cannot be a fixed prefix.
			if ( '' === $segment || '%' === substr( $segment, 0, 1 ) ) {
				break;
			}
			$static[] = $segment;
		}

		if ( empty( $static ) ) {
			return array();
		}

		return array( strtolower( implode( '/', $static ) ) . '/' );
	}
}
