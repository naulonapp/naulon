<?php
/**
 * API-key format + masking.
 *
 * The key never leaves the server: every control-plane call is server-side PHP, the key is
 * never printed into HTML, never returned by a REST route, and the admin screen shows only the
 * same short preview the portal shows. This class owns the two rules that make that checkable
 * — what a key looks like, and what a human is allowed to see of it.
 *
 * The connectivity field accepts EITHER a hosted key or a self-host gate URL, and tells them
 * apart by the `nln_live_` prefix. That prefix is deliberate upstream: a recognizable, typed
 * prefix is what lets leak scanners find these in a public repo.
 *
 * Pure functions, no WordPress calls.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Key {

	/** The typed prefix every hosted key carries. */
	const PREFIX = 'nln_live_';

	/** How many body characters the masked preview reveals — matches the portal's preview. */
	const PREVIEW_CHARS = 4;

	/**
	 * Does this look like a hosted API key? Shape only — whether the control plane still
	 * honors it is a network question, answered by a status call, never by this.
	 *
	 * @param mixed $candidate Candidate.
	 * @return bool
	 */
	public static function looks_like_key( $candidate ) {
		if ( ! is_string( $candidate ) ) {
			return false;
		}
		$value = trim( $candidate );
		if ( 0 !== strpos( $value, self::PREFIX ) ) {
			return false;
		}
		$body = substr( $value, strlen( self::PREFIX ) );
		// base62 body, minted from 256 bits upstream. Length varies slightly with the leading
		// digits of the number, so bound it rather than pinning one exact length.
		return 1 === preg_match( '/^[0-9A-Za-z]{32,64}$/', $body );
	}

	/**
	 * Does this look like a self-hosted gate URL (the free tier's answer to the same field)?
	 * https is required for the same reason the control plane's own fetches are https-only:
	 * a key or a toll decision must never cross the wire in clear text. http is permitted for
	 * a loopback host so a developer can point at their own gate.
	 *
	 * @param mixed $candidate Candidate.
	 * @return bool
	 */
	public static function looks_like_gate_url( $candidate ) {
		if ( ! is_string( $candidate ) ) {
			return false;
		}
		$value = trim( $candidate );
		if ( 1 !== preg_match( '#^https?://#i', $value ) ) {
			return false;
		}
		$host = wp_parse_url( $value, PHP_URL_HOST );
		if ( ! is_string( $host ) || '' === $host ) {
			return false;
		}
		if ( 0 === strpos( strtolower( $value ), 'http://' ) ) {
			return in_array( strtolower( $host ), array( 'localhost', '127.0.0.1', '::1' ), true );
		}
		return true;
	}

	/**
	 * The only representation of a key that may be rendered to a human: prefix + the first few
	 * body characters + an ellipsis. Never the tail — a tail plus a leaked prefix is most of a
	 * key, and previews end up in screenshots and support tickets.
	 *
	 * @param mixed $key The key.
	 * @return string Masked preview, or '' when there is nothing to show.
	 */
	public static function mask( $key ) {
		if ( ! is_string( $key ) || '' === trim( $key ) ) {
			return '';
		}
		$value = trim( $key );
		if ( ! self::looks_like_key( $value ) ) {
			// Not a key (a gate URL, or junk) — nothing secret to protect, but never echo an
			// arbitrary stored string either. Show the scheme+host of a URL, otherwise nothing.
			$host = wp_parse_url( $value, PHP_URL_HOST );
			return is_string( $host ) ? $host : '';
		}
		$body = substr( $value, strlen( self::PREFIX ) );
		return self::PREFIX . substr( $body, 0, self::PREVIEW_CHARS ) . '…';
	}
}
