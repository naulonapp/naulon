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
	public function enforce_status( $key = null, $base = null ) {
		return $this->request( 'GET', '/_naulon/enforce-status', null, self::TIMEOUT_ADMIN, $key, $base );
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
	public function quote( $resource, $slug, $kind = 'read', $build_402 = false ) {
		$args = array(
			'resource' => $resource,
			'slug'     => $slug,
			'kind'     => $kind,
		);
		// `build=402` asks the control plane to ALSO return the built 402 — the header bytes and
		// the settlement legs — derived by the same builder the gate uses and the same one
		// /verify re-derives legs with when it checks our settle request.
		//
		// This is why there is no money math in this plugin. Converting a quote into legs means
		// atomic USDC conversion, the co-author split and its remainder rule, and the exact
		// requirements shape. Re-implementing that in PHP would be a second source of truth for
		// how much each author is paid, and a rounding difference would not throw — it would
		// quietly pay the wrong amount. So we do not implement it; we ask for the answer.
		if ( $build_402 ) {
			$args['build'] = '402';
		}
		return $this->request( 'GET', '/_naulon/quote?' . http_build_query( $args ), null, self::TIMEOUT_REQUEST );
	}

	/**
	 * Settle a presented payment. The control plane verifies the buyer's signature, moves the
	 * money buyer→author (custody-free — nothing is ever held here or there), and mints the
	 * re-read license.
	 *
	 * `legs` and `quote` are handed back exactly as received from `quote(build_402: true)`.
	 * The control plane re-derives what the legs SHOULD be and refuses a mismatch, so a stale
	 * or tampered cache fails to a 400 rather than to a mispayment.
	 *
	 * @param string $payment  The buyer's payment-signature header value.
	 * @param array  $legs     Legs from the built 402.
	 * @param array  $quote    The quote from the same response.
	 * @param string $resource Absolute URL of the resource being paid for.
	 * @return array
	 */
	public function settle( $payment, array $legs, array $quote, $resource ) {
		return $this->request(
			'POST',
			'/_naulon/verify',
			array(
				'payment'  => $payment,
				'legs'     => $legs,
				'quote'    => $quote,
				'resource' => $resource,
			),
			self::TIMEOUT_ADMIN
		);
	}

	/**
	 * Does a presented license entitle a free re-read?
	 *
	 * Verified by the control plane rather than here, for the same reason the 402 is built
	 * there: local verification would mean re-implementing EdDSA JWS verification plus the
	 * entitlement rules (issuer and audience pinning, slug scope, read vs citation, expiry,
	 * holder-of-key binding). A second implementation of security-critical verification is a
	 * second chance to accept a forged token.
	 *
	 * @param string $license  The presented license JWS.
	 * @param string $resource Absolute URL being re-read.
	 * @param string $slug     Canonical slug.
	 * @param string $kind     read|citation.
	 * @param string $proof    Forwarded holder-of-key proof header, or ''.
	 * @return array
	 */
	public function license_check( $license, $resource, $slug, $kind = 'read', $proof = '' ) {
		$body = array(
			'license'  => $license,
			'resource' => $resource,
			'slug'     => $slug,
			'kind'     => $kind,
		);
		if ( '' !== $proof ) {
			$body['proof'] = $proof;
		}
		return $this->request( 'POST', '/_naulon/license/check', $body, self::TIMEOUT_REQUEST );
	}

	/**
	 * Report gating decisions to the audit plane.
	 *
	 * Always a JSON ARRAY, even for one report: the endpoint accepts either shape, and sending
	 * the array form unconditionally means a batch and a single decision travel the same code
	 * path here and on the far side.
	 *
	 * The two money verdicts are refused by the endpoint with a 400 that explains why, and
	 * Naulon_Observer never builds one — see that class for the writer split.
	 *
	 * @param array $reports One or more observation reports.
	 * @return array {ok:bool, status:int, body:array|null, error:string}
	 */
	public function observe( array $reports ) {
		return $this->request( 'POST', '/_naulon/observe', array_values( $reports ), self::TIMEOUT_REQUEST );
	}

	/**
	 * One HTTP call. Never throws.
	 *
	 * @param string     $method  HTTP method.
	 * @param string     $path    Path beginning with '/'.
	 * @param array|null $body    JSON body, or null.
	 * @param int        $timeout Seconds.
	 * @param string|null $key    Override key (rotation), else the stored one.
	 * @param string|null $base   Override base URL (validating a pasted self-host gate URL before
	 *                            it is stored), else the configured one.
	 * @return array {ok:bool, status:int, body:array|null, error:string}
	 */
	private function request( $method, $path, $body, $timeout, $key = null, $base = null ) {
		$api_key = null === $key ? Naulon_Settings::api_key() : $key;
		$url     = ( null === $base ? Naulon_Settings::api_base() : untrailingslashit( $base ) ) . $path;

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
