<?php
/**
 * The self-test that decides whether this site can toll files.
 *
 * Writing a rewrite rule proves nothing: nginx ignores `.htaccess`, a host can disable overrides,
 * a CDN can answer from cache, and a media plugin can serve uploads from another host. So the
 * plugin asks its own public URL for a probe file, the way a crawler would, and counts the route
 * as working only when the reply echoes a nonce minted for that one request. A cache can replay a
 * reply; it cannot replay one carrying a nonce that did not exist when the reply was stored.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_File_Probe {

	/** The probe directory under uploads; always routed, so the test can run before any type is opted in. */
	const DIR = 'naulon-probe';

	/** The probe file. */
	const FILE = 'probe.pdf';

	/** The request header carrying a nonce, and the response header echoing it. */
	const REQUEST_HEADER  = 'X-Naulon-Probe';
	const RESPONSE_HEADER = 'X-Naulon-File';

	/** Live nonces, newest last. */
	const NONCE_TRANSIENT = 'naulon_file_probe_nonces';
	const NONCE_TTL       = 300;
	const NONCE_KEEP      = 12;

	/** @var Naulon_File_Probe|null */
	private static $instance = null;

	/**
	 * @return Naulon_File_Probe
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Mint a nonce for one probe request.
	 *
	 * @return string
	 */
	public function issue_nonce() {
		$nonce  = wp_generate_password( 24, false );
		$nonces = get_transient( self::NONCE_TRANSIENT );
		$nonces = is_array( $nonces ) ? $nonces : array();
		$nonces[] = $nonce;
		set_transient( self::NONCE_TRANSIENT, array_slice( $nonces, -self::NONCE_KEEP ), self::NONCE_TTL );
		return $nonce;
	}

	/**
	 * Was this nonce minted here in the last few minutes?
	 *
	 * @param string $nonce From the request header.
	 * @return bool
	 */
	public function nonce_valid( $nonce ) {
		if ( ! is_string( $nonce ) || '' === $nonce ) {
			return false;
		}
		$nonces = get_transient( self::NONCE_TRANSIENT );
		return is_array( $nonces ) && in_array( $nonce, $nonces, true );
	}
}
