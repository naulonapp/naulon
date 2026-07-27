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

require_once __DIR__ . '/../includes/class-naulon-slug.php';
require_once __DIR__ . '/../includes/class-naulon-wallet.php';
require_once __DIR__ . '/../includes/class-naulon-key.php';
require_once __DIR__ . '/../includes/class-naulon-agent.php';
