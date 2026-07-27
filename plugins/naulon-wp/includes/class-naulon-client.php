<?php
/**
 * The control-plane HTTP client. Every call in here is server-side; the key never reaches a
 * browser.
 *
 * Timeouts are short and every failure is a value, never an exception: a plugin that breaks a
 * WordPress site gets uninstalled and never reinstalled, so an unreachable control plane must
 * degrade to "serve the page" rather than to a white screen. The request-path timeout is
 * deliberately tighter than the admin one — a reader is waiting on the first, an administrator
 * who just clicked a button is waiting on the second and would rather wait than retry.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Client {

	/** Request-path budget: a reader is blocked on this. */
	const TIMEOUT_REQUEST = 2;

	/** Admin-action budget: verification and settlement calls may legitimately take longer. */
	const TIMEOUT_ADMIN = 10;

	/** @var Naulon_Client|null */
	private static $instance = null;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Enforcement status for every host this key's tenant owns. Doubles as the connectivity
	 * probe and as the key-rotation validator — a new key is checked HERE before it replaces
	 * the stored one, so a typo cannot take the toll offline.
	 *
	 * Note the path: `enforce-status`, not `status`. There is no `/_naulon/status` route.
	 *
	 * @param string|null $key Override key (rotation check). Null = the stored key.
	 * @return array {ok:bool, status:int, body:array|null, error:string}
	 */
	public function enforce_status( $key = null ) {
		return $this->request( 'GET', '/_naulon/enforce-status', null, self::TIMEOUT_ADMIN, $key );
	}

	/**
	 * Open (or re-fetch) the ownership challenge for a host, and learn what to serve.
	 * `well-known` is the default because a plugin can always serve a file path, whereas the
	 * meta tag depends on the theme actually rendering wp_head.
	 *
	 * @param string $host   The host to prove.
	 * @param string $method well-known|meta-tag|dns-txt.
	 * @return array
	 */
	public function open_challenge( $host, $method = 'well-known' ) {
		return $this->request(
			'POST',
			'/_naulon/verify-host',
			array(
				'host'   => $host,
				'method' => $method,
			),
			self::TIMEOUT_ADMIN
		);
	}

	/**
	 * Ask the control plane to fetch the challenge and stamp ownership. 200 = proven; 409 is a
	 * normal "not yet" carrying the reason a diagnosis is built from, NOT an error.
	 *
	 * @param string $host The host being proven.
	 * @return array
	 */
	public function check_challenge( $host ) {
		return $this->request( 'POST', '/_naulon/verify-host/check', array( 'host' => $host ), self::TIMEOUT_ADMIN );
	}

	/**
	 * This tenant's challenge state.
	 *
	 * @return array
	 */
	public function list_challenges() {
		return $this->request( 'GET', '/_naulon/verify-host', null, self::TIMEOUT_ADMIN );
	}

	/**
	 * Price one resource. `204` is the deliberate don't-gate signal (untollable, wallet-less,
	 * free-listed) and comes back as ok:true with a null body — free is an ANSWER, not a
	 * failure.
	 *
	 * This call is also the in-app liveness heartbeat: `/quote` and `/verify` are the only two
	 * legs that stamp `last_inapp_verify_at` upstream, so a site that prices locally and has
	 * not been paid yet would otherwise read as a dead integration and get flagged
	 * `reconnect_sdk`. Calling it on cron keeps the record honest and refreshes the price.
	 *
	 * @param string $resource Absolute URL of the resource.
	 * @param string $slug     Canonical slug.
	 * @param string $kind     read|citation.
	 * @return array
	 */
	public function quote( $resource, $slug, $kind = 'read' ) {
		$query = http_build_query(
			array(
				'resource' => $resource,
				'slug'     => $slug,
				'kind'     => $kind,
			)
		);
		return $this->request( 'GET', '/_naulon/quote?' . $query, null, self::TIMEOUT_REQUEST );
	}

	/**
	 * One HTTP call. Never throws.
	 *
	 * @param string     $method  HTTP method.
	 * @param string     $path    Path beginning with '/'.
	 * @param array|null $body    JSON body, or null.
	 * @param int        $timeout Seconds.
	 * @param string|null $key    Override key (rotation), else the stored one.
	 * @return array {ok:bool, status:int, body:array|null, error:string}
	 */
	private function request( $method, $path, $body, $timeout, $key = null ) {
		$api_key = null === $key ? Naulon_Settings::api_key() : $key;
		$url     = Naulon_Settings::api_base() . $path;

		$headers = array( 'Accept' => 'application/json' );
		if ( '' !== $api_key ) {
			$headers['Authorization'] = 'Bearer ' . $api_key;
		}
		$args = array(
			'method'  => $method,
			'timeout' => $timeout,
			'headers' => $headers,
			// A control-plane call must never be answered by a redirect we blindly follow.
			'redirection' => 0,
		);
		if ( null !== $body ) {
			$args['headers']['Content-Type'] = 'application/json';
			$args['body']                    = wp_json_encode( $body );
		}

		$response = wp_remote_request( $url, $args );
		if ( is_wp_error( $response ) ) {
			return array(
				'ok'     => false,
				'status' => 0,
				'body'   => null,
				'error'  => $response->get_error_message(),
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$raw    = wp_remote_retrieve_body( $response );
		$parsed = ( '' === $raw ) ? null : json_decode( $raw, true );
		if ( ! is_array( $parsed ) ) {
			$parsed = null;
		}

		return array(
			'ok'     => $status >= 200 && $status < 300,
			'status' => $status,
			'body'   => $parsed,
			'error'  => '',
		);
	}
}
