<?php
/**
 * Unit bootstrap for the classes that carry no WordPress dependency — slug canonicalization,
 * wallet validation, key format and masking. Those three are where the money-routing decisions
 * live, so they get tested without the cost of a WordPress install: fast enough to run on every
 * change, which is the only kind of test that actually gets run.
 *
 * The integration surfaces (REST route, rewrite, capabilities) are tested against real
 * WordPress under wp-env; that suite is separate on purpose.
 *
 * @package naulon
 */

define( 'ABSPATH', __DIR__ . '/' );

/**
 * The few WordPress functions the pure classes touch. Kept deliberately thin — if a class under
 * test starts needing more than this, that is the signal it belongs in the wp-env suite instead.
 */
if ( ! function_exists( 'wp_parse_url' ) ) {
	function wp_parse_url( $url, $component = -1 ) { // phpcs:ignore
		return parse_url( $url, $component );
	}
}
if ( ! function_exists( '__' ) ) {
	function __( $text, $domain = 'default' ) { // phpcs:ignore
		return $text;
	}
}
if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( $text ) { // phpcs:ignore
		return htmlspecialchars( (string) $text, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'number_format_i18n' ) ) {
	function number_format_i18n( $number, $decimals = 0 ) { // phpcs:ignore
		return number_format( (float) $number, (int) $decimals );
	}
}
if ( ! function_exists( 'wp_strip_all_tags' ) ) {
	function wp_strip_all_tags( $text ) { // phpcs:ignore
		return strip_tags( (string) $text ); // phpcs:ignore
	}
}
if ( ! function_exists( 'sanitize_text_field' ) ) {
	function sanitize_text_field( $str ) { // phpcs:ignore
		return trim( wp_strip_all_tags( $str ) );
	}
}

require_once __DIR__ . '/../includes/class-naulon-slug.php';
require_once __DIR__ . '/../includes/class-naulon-wallet.php';
require_once __DIR__ . '/../includes/class-naulon-key.php';
require_once __DIR__ . '/../includes/class-naulon-agent.php';
// Money formatting and the settlement-mode read are pure functions over integers and a header
// string, so they belong in the fast suite — the parts of the ledger that touch a database are
// covered by the wp-env suite instead.
require_once __DIR__ . '/../includes/class-naulon-ledger.php';
require_once __DIR__ . '/../includes/admin/class-naulon-admin-content.php';
// Only the DEFAULT_API_BASE constant is exercised here — reading it needs no WordPress, and
// getting it wrong tells every publisher their key was rejected. See ControlPlaneAddressTest.
require_once __DIR__ . '/../includes/class-naulon-settings.php';
// Only `merge_vary` is exercised here — a pure string merge over a header value. The header it
// produces is what stops a shared cache replaying a human's free 200 to a crawler. See CacheVaryTest.
require_once __DIR__ . '/../includes/class-naulon-enforcer.php';
// Only `edge_remedy` is exercised here — a pure function over a header bag whose output is
// publisher-facing copy on a branch the admin screens cannot reach offline. See EdgeRemedyTest.
require_once __DIR__ . '/../includes/class-naulon-cache.php';
