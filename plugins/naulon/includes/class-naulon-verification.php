<?php
/**
 * Ownership verification — open the challenge, serve it, ask the control plane to check it.
 *
 * This is a HARD GATE, not a nicety. In-app enforcement resolves the publisher through a
 * verified-ownership lookup precisely because an in-app host is deliberately absent from the
 * fleet routing set. Without a stamped challenge the hosted verify leg answers
 * `403 resource not owned by this key`, so a 402 this plugin issued could never be settled:
 * we would be charging agents for a transaction we cannot complete. Enforcement therefore
 * stays off until this passes.
 *
 * The other half of this class is DIAGNOSIS. A bare "not verified" is useless to the exact
 * publisher this path exists for — someone who chose WordPress specifically to avoid touching
 * DNS. Every known failure mode is checked and named: not HTTPS, the host redirects somewhere
 * else, `/.well-known/` is being swallowed, the token served is stale. The screen shows the
 * bytes actually returned, so a swallowed challenge is visible rather than mysterious.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Verification {

	/**
	 * The host this site actually serves on, per its own configured home URL.
	 *
	 * @return string
	 */
	public static function host() {
		$host = wp_parse_url( home_url(), PHP_URL_HOST );
		return is_string( $host ) ? strtolower( $host ) : '';
	}

	/**
	 * Is the site served over HTTPS? The control plane's checker is https-only, so a plain-http
	 * site cannot be verified by either HTTP method no matter what we serve.
	 *
	 * @return bool
	 */
	public static function is_https() {
		return 'https' === strtolower( (string) wp_parse_url( home_url(), PHP_URL_SCHEME ) );
	}

	/**
	 * Are permalinks set to something other than plain?
	 *
	 * This is a prerequisite for the whole plugin, not just for verification, and it fails
	 * silently in both directions. With plain permalinks a post's URL is `?p=123`, which has no
	 * path — so the canonical slug is empty, the credits lookup finds nothing, and every article
	 * reads free with no error anywhere. The rewrite that serves the ownership challenge does not
	 * exist either. A publisher would see a plugin that is connected, verified-looking and
	 * earning nothing.
	 *
	 * @return bool
	 */
	public static function permalinks_ok() {
		return '' !== trim( (string) get_option( 'permalink_structure' ) );
	}

	/**
	 * Step 1 — open the challenge and remember what to serve.
	 *
	 * @param string $method well-known|meta-tag|dns-txt.
	 * @return array {ok:bool, message:string, token:string}
	 */
	public static function start( $method = 'well-known' ) {
		$host = self::host();
		if ( '' === $host ) {
			return array(
				'ok'      => false,
				'message' => __( 'Could not work out which host this site serves on.', 'naulon' ),
				'token'   => '',
			);
		}

		$response = Naulon_Client::instance()->open_challenge( $host, $method );

		// A 409 means the host is already verified — but NOT necessarily by us, and that difference
		// is money. `routingVerified` says which proof made it live:
		//
		//   true  — the domain is CNAME'd to the naulon fleet and a live probe confirmed it reaches
		//           the gate, so the FLEET IS ALREADY TOLLING IT. Switching in-app enforcement on
		//           would put our 402 behind the fleet's and charge an agent twice for one read.
		//           Refuse, and do not stamp verified_at (the enforcer gates on it, so enforcement
		//           stays off).
		//   false — verified for in-app, nothing routes it. The publisher is simply done.
		//
		// ABSENT is treated as true. An older control plane sends the bare `{error}` this branch
		// used to read as plain success, and that is exactly the bug: the two situations are
		// indistinguishable without the field. A false refusal is loud and recoverable; a false
		// "carry on" silently double-charges every agent that reads the site.
		if ( 409 === $response['status'] && isset( $response['body']['error'] ) && 'host_already_added' === $response['body']['error'] ) {
			$routing_verified = ! isset( $response['body']['routingVerified'] ) || ! empty( $response['body']['routingVerified'] );

			if ( $routing_verified ) {
				return array(
					'ok'      => false,
					'message' => __( 'This domain is routed through the naulon fleet, which is already collecting the toll for it. Turning on in-app enforcement as well would charge an agent twice for the same read, so it stays off. To run the toll from WordPress instead, remove the naulon CNAME record for this domain at your DNS provider, wait for it to stop resolving, then run this step again.', 'naulon' ),
					'token'   => '',
				);
			}

			Naulon_Settings::update(
				array(
					'challenge_host'    => $host,
					'verified_at'       => gmdate( 'c' ),
					'ownership_lost_at' => '', // the proof is back; the "you lost it" screen must not linger
				)
			);
			return array(
				'ok'      => true,
				'message' => __( 'This site is already verified.', 'naulon' ),
				'token'   => '',
			);
		}

		if ( ! $response['ok'] || ! isset( $response['body']['challenge']['token'] ) ) {
			return array(
				'ok'      => false,
				'message' => self::connection_error( $response ),
				'token'   => '',
			);
		}

		$challenge = $response['body']['challenge'];
		$token     = (string) $challenge['token'];

		Naulon_Settings::update(
			array(
				'challenge_host'   => $host,
				'challenge_token'  => $token,
				'challenge_method' => isset( $challenge['method'] ) ? (string) $challenge['method'] : $method,
				'verified_at'      => isset( $challenge['verifiedAt'] ) && $challenge['verifiedAt'] ? (string) $challenge['verifiedAt'] : '',
			)
		);

		// The rewrite rule must exist before the checker asks for the path. On a site that was
		// activated before this version, or where another plugin flushed rules, it may not.
		Naulon_Challenge::instance()->add_rewrite_rules();
		flush_rewrite_rules( false );

		return array(
			'ok'      => true,
			'message' => __( 'Challenge ready. This site is now serving the proof.', 'naulon' ),
			'token'   => $token,
		);
	}

	/**
	 * Step 2 — ask the control plane to fetch it and stamp ownership.
	 *
	 * @return array {ok:bool, message:string, diagnosis:string[]}
	 */
	public static function complete() {
		$host     = self::host();
		$response = Naulon_Client::instance()->check_challenge( $host );

		if ( $response['ok'] ) {
			Naulon_Settings::update(
				array(
					'verified_at'       => gmdate( 'c' ),
					'ownership_lost_at' => '', // recovered; stop telling them they lost it
				)
			);
			return array(
				'ok'        => true,
				'message'   => __( 'Ownership verified. This site can now settle tolls.', 'naulon' ),
				'diagnosis' => array(),
			);
		}

		if ( 409 === $response['status'] ) {
			$reason = isset( $response['body']['reason'] ) ? (string) $response['body']['reason'] : 'not_verified';
			return array(
				'ok'        => false,
				'message'   => self::reason_message( $reason ),
				'diagnosis' => self::diagnose(),
			);
		}

		return array(
			'ok'        => false,
			'message'   => self::connection_error( $response ),
			'diagnosis' => array(),
		);
	}

	/**
	 * Everything we can determine locally about why a check failed. Each entry is a finding a
	 * publisher can act on, in the order they are worth acting on.
	 *
	 * @return string[]
	 */
	public static function diagnose() {
		$findings = array();

		if ( ! self::is_https() ) {
			$findings[] = __( 'This site is served over http. The ownership check is https-only, so it can never succeed until the site has a certificate.', 'naulon' );
		}

		$settings = Naulon_Settings::all();
		$token    = is_string( $settings['challenge_token'] ) ? $settings['challenge_token'] : '';
		if ( '' === $token ) {
			$findings[] = __( 'No challenge is open. Start verification first.', 'naulon' );
			return $findings;
		}

		$probe = self::self_probe( Naulon_Challenge::challenge_url( $token ) );

		if ( 0 === $probe['status'] ) {
			$findings[] = sprintf(
				/* translators: %s: transport error message. */
				__( 'This site could not fetch its own challenge URL (%s). That is usually a firewall or a loopback restriction on the host, not a naulon problem — but the control plane may hit the same wall.', 'naulon' ),
				$probe['error']
			);
		} elseif ( $probe['status'] >= 300 && $probe['status'] < 400 ) {
			$findings[] = sprintf(
				/* translators: 1: HTTP status, 2: redirect target. */
				__( 'The challenge URL answers %1$d and redirects to %2$s. Redirects are never followed by the checker, so verification must run against the host that actually serves the page — usually the www or non-www variant you were not expecting.', 'naulon' ),
				$probe['status'],
				'' !== $probe['location'] ? $probe['location'] : __( 'another address', 'naulon' )
			);
		} elseif ( 404 === $probe['status'] ) {
			$findings[] = __( 'The challenge URL returns 404. Something is intercepting /.well-known/ — commonly a security plugin, a static-file handler, or stale permalinks. Re-saving Settings → Permalinks fixes the stale case; the meta-tag method sidesteps the interception entirely.', 'naulon' );
		} elseif ( 200 !== $probe['status'] ) {
			$findings[] = sprintf(
				/* translators: %d: HTTP status code. */
				__( 'The challenge URL returns %d. The checker only accepts a 2xx.', 'naulon' ),
				$probe['status']
			);
		} elseif ( trim( $probe['body'] ) !== $token ) {
			$findings[] = sprintf(
				/* translators: %s: the first bytes actually returned. */
				__( 'The challenge URL answered 200 but the body was not the token. It returned: %s', 'naulon' ),
				'"' . esc_html( substr( trim( $probe['body'] ), 0, 120 ) ) . '"'
			);
		}

		if ( empty( $findings ) ) {
			$findings[] = __( 'This site is serving the challenge correctly from here. If the check still fails, the control plane is reaching a different server than this one — check for a CDN, a staging copy, or DNS that points elsewhere.', 'naulon' );
		}

		return $findings;
	}

	/**
	 * Fetch a URL from this server, following nothing, and report exactly what came back. The
	 * point is to show the publisher the real bytes rather than a verdict.
	 *
	 * @param string $url URL to probe.
	 * @return array {status:int, body:string, location:string, error:string}
	 */
	public static function self_probe( $url ) {
		$response = wp_remote_get(
			$url,
			array(
				'timeout'     => Naulon_Client::TIMEOUT_ADMIN,
				'redirection' => 0,
				'headers'     => array( 'Cache-Control' => 'no-cache' ),
			)
		);
		if ( is_wp_error( $response ) ) {
			return array(
				'status'   => 0,
				'body'     => '',
				'location' => '',
				'error'    => $response->get_error_message(),
			);
		}
		return array(
			'status'   => (int) wp_remote_retrieve_response_code( $response ),
			'body'     => (string) wp_remote_retrieve_body( $response ),
			'location' => (string) wp_remote_retrieve_header( $response, 'location' ),
			'error'    => '',
		);
	}

	/**
	 * Turn the control plane's machine reason into a sentence.
	 *
	 * @param string $reason no_challenge|not_verified|dns_mismatch|host_taken.
	 * @return string
	 */
	private static function reason_message( $reason ) {
		switch ( $reason ) {
			case 'no_challenge':
				return __( 'No challenge is open for this host. Start verification again.', 'naulon' );
			case 'dns_mismatch':
				return __( 'The DNS TXT record does not match yet. DNS changes can take a while to propagate.', 'naulon' );
			case 'host_taken':
				return __( 'Another account already verified this domain. If that was you, connect this site with that account\'s key instead.', 'naulon' );
			default:
				return __( 'The control plane could not see the proof yet.', 'naulon' );
		}
	}

	/**
	 * A connection failure, said plainly. A revoked or mistyped key is the common case and
	 * must be loud — a silently unconnected plugin serves everything free.
	 *
	 * @param array $response Client response.
	 * @return string
	 */
	private static function connection_error( array $response ) {
		if ( 401 === $response['status'] ) {
			return __( 'The control plane rejected this API key (401). It may have been revoked or mistyped. Nothing is being tolled until this is fixed.', 'naulon' );
		}
		if ( 403 === $response['status'] ) {
			// A setup key is deliberately single-use for this one job. The control plane drops
			// `domain.manage` from it the moment the domain verifies, so a 403 AFTER verification is
			// the design working, not a fault — and the remedy is a NEW key, never "fix this one".
			// Before verification a 403 means the key was assembled from the permission matrix,
			// which offers read access only; such a key can never prove a domain, and saying
			// "issue a key with the domain-management scope" sent people looking for a checkbox
			// that does not exist. Name the preset in both cases — it is the only thing that mints
			// this scope.
			if ( Naulon_Settings::is_verified() ) {
				return __( 'This site is already verified, so the setup key has handed its domain permission back — it only ever needed it once. To claim a domain from here again, open your naulon dashboard, go to Settings → API & webhooks → Create key, choose "Connect WordPress", and paste the new key on this page.', 'naulon' );
			}
			return __( 'This key cannot claim domains (403). In your naulon dashboard go to Settings → API & webhooks → Create key and choose "Connect WordPress" — that preset is the only one that mints the permission this step needs. A key built from the permission list is read-only and can never prove this domain.', 'naulon' );
		}
		if ( 0 === $response['status'] ) {
			return sprintf(
				/* translators: %s: transport error. */
				__( 'Could not reach the control plane: %s', 'naulon' ),
				$response['error']
			);
		}
		return sprintf(
			/* translators: %d: HTTP status code. */
			__( 'The control plane answered %d.', 'naulon' ),
			$response['status']
		);
	}
}
