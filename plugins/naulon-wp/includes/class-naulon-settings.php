<?php
/**
 * Settings storage — and specifically, where the API key lives.
 *
 * Priority: a `NAULON_API_KEY` constant in wp-config.php wins over the database. That order is
 * the whole point. A DB option rides along in every export, every migration dump, and every
 * backup a host emails around; a wp-config constant does not. The option exists only because
 * plenty of publishers cannot edit wp-config, and a toll they cannot turn on is worth less
 * than a key stored one notch less well — but the admin screen says which one is in use, and
 * offers the constant as the better move.
 *
 * The option is registered with autoload OFF: a secret has no business being loaded into
 * memory on every single request, including the ones that never talk to the control plane.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Settings {

	const OPTION = 'naulon_settings';

	/** Default hosted control plane. Overridable for self-host and for tests. */
	const DEFAULT_API_BASE = 'https://api.naulon.app';

	/**
	 * The whole settings array, with defaults filled in.
	 *
	 * @return array
	 */
	public static function all() {
		$stored = get_option( self::OPTION, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array_merge(
			array(
				'api_key'           => '',
				'api_base'          => '',
				'gate_url'          => '',
				'challenge_host'    => '',
				'challenge_token'   => '',
				'challenge_method'  => '',
				'verified_at'       => '',
				'credits_token'     => '',
				'enforcement_on'    => false,
			),
			$stored
		);
	}

	/**
	 * Merge and persist. Autoload stays 'no' — see the class docblock.
	 *
	 * @param array $changes Partial settings.
	 * @return void
	 */
	public static function update( array $changes ) {
		$next = array_merge( self::all(), $changes );
		update_option( self::OPTION, $next, 'no' );
	}

	/**
	 * The API key in force, constant first. Returns '' when the site is not connected.
	 *
	 * @return string
	 */
	public static function api_key() {
		if ( defined( 'NAULON_API_KEY' ) && is_string( NAULON_API_KEY ) && '' !== trim( NAULON_API_KEY ) ) {
			return trim( NAULON_API_KEY );
		}
		$settings = self::all();
		return is_string( $settings['api_key'] ) ? trim( $settings['api_key'] ) : '';
	}

	/**
	 * Where the key is stored, for the admin screen to report honestly.
	 *
	 * @return string One of 'constant', 'option', 'none'.
	 */
	public static function key_source() {
		if ( defined( 'NAULON_API_KEY' ) && is_string( NAULON_API_KEY ) && '' !== trim( NAULON_API_KEY ) ) {
			return 'constant';
		}
		$settings = self::all();
		return '' !== trim( (string) $settings['api_key'] ) ? 'option' : 'none';
	}

	/**
	 * The control plane base URL. A self-host gate URL in the connectivity field wins; then an
	 * explicit override constant; then the hosted default.
	 *
	 * @return string No trailing slash.
	 */
	public static function api_base() {
		$settings = self::all();
		if ( is_string( $settings['gate_url'] ) && '' !== trim( $settings['gate_url'] ) ) {
			return untrailingslashit( trim( $settings['gate_url'] ) );
		}
		if ( defined( 'NAULON_API_BASE' ) && is_string( NAULON_API_BASE ) && '' !== trim( NAULON_API_BASE ) ) {
			return untrailingslashit( trim( NAULON_API_BASE ) );
		}
		if ( is_string( $settings['api_base'] ) && '' !== trim( $settings['api_base'] ) ) {
			return untrailingslashit( trim( $settings['api_base'] ) );
		}
		return self::DEFAULT_API_BASE;
	}

	/**
	 * Is this site connected to something that can price and settle a toll?
	 *
	 * @return bool
	 */
	public static function is_connected() {
		$settings = self::all();
		$gate_url = is_string( $settings['gate_url'] ) ? trim( $settings['gate_url'] ) : '';
		return '' !== self::api_key() || '' !== $gate_url;
	}

	/**
	 * Has this site proven ownership of the host it serves on? In-app enforcement is refused
	 * until this is true: without a verified challenge the hosted /verify leg answers 403
	 * "resource not owned by this key", so a 402 we issued could never be settled — we would
	 * be charging agents for something we cannot complete.
	 *
	 * @return bool
	 */
	public static function is_verified() {
		$settings = self::all();
		return '' !== trim( (string) $settings['verified_at'] );
	}

	/**
	 * Remove everything this plugin stored. Called from uninstall only.
	 *
	 * @return void
	 */
	public static function delete_all() {
		delete_option( self::OPTION );
	}
}
