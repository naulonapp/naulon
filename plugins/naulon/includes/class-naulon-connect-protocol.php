<?php
/**
 * The wire rules of connect, with no WordPress in them: what a gate's discovery document must say,
 * what a site origin is, and the PKCE challenge. Held to the same answers as the TypeScript and Python
 * runtimes by packages/shared/test-fixtures/connect-cases.json.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Connect_Protocol {

	const PROTOCOL        = 'naulon/1';
	const DISCOVERY_PATH  = '/.well-known/naulon';
	const CHALLENGE_PATH  = '/.well-known/naulon-challenge/';
	const CLIENT_PATH     = '/.well-known/naulon-client';
	const SITE_SCOPE      = 'site.enforce';
	const STATE_PATTERN   = '/^[A-Za-z0-9\-_]{22,128}$/';
	const CREDENTIAL      = '/^nln_site_[0-9A-Za-z]{43}$/';
	const VERIFIER        = '/^[A-Za-z0-9\-._~]{43,128}$/';

	/**
	 * `localhost`, any of 127.0.0.0/8, or `::1`: a name that can only mean this machine.
	 *
	 * @param string $host Hostname, brackets allowed.
	 * @return bool
	 */
	public static function is_loopback( $host ) {
		$h = strtolower( trim( (string) $host, '[]' ) );
		if ( 'localhost' === $h || '::1' === $h ) {
			return true;
		}
		$ip = Naulon_Ip::parse( $h );
		return null !== $ip && 4 === $ip['family'] && 127 === ord( $ip['bytes'][0] );
	}

	/**
	 * An origin with no path, query or credentials. Plain http only on loopback.
	 *
	 * @param string $raw URL.
	 * @return string|null
	 */
	public static function origin_of( $raw ) {
		$u = wp_parse_url( trim( (string) $raw ) );
		if ( ! is_array( $u ) || empty( $u['host'] ) || empty( $u['scheme'] ) || isset( $u['user'] ) || isset( $u['pass'] ) ) {
			return null;
		}
		$scheme = strtolower( $u['scheme'] );
		$host   = strtolower( $u['host'] );
		if ( 'https' !== $scheme && ! ( 'http' === $scheme && self::is_loopback( $host ) ) ) {
			return null;
		}
		$default = 'https' === $scheme ? 443 : 80;
		$port    = isset( $u['port'] ) && (int) $u['port'] !== $default ? ':' . (int) $u['port'] : '';
		return $scheme . '://' . $host . $port;
	}

	/**
	 * The origin a site is connected as. Anything after the origin makes it not one.
	 *
	 * @param string $raw URL.
	 * @return string|null
	 */
	public static function site_origin( $raw ) {
		$origin = self::origin_of( $raw );
		if ( null === $origin ) {
			return null;
		}
		$u    = wp_parse_url( trim( (string) $raw ) );
		$path = isset( $u['path'] ) ? $u['path'] : '';
		return ( '' === $path || '/' === $path ) && ! isset( $u['query'] ) && ! isset( $u['fragment'] ) ? $origin : null;
	}

	/**
	 * RFC 7636 S256.
	 *
	 * @param string $verifier 43 to 128 unreserved characters.
	 * @return string
	 * @throws InvalidArgumentException For a malformed verifier.
	 */
	public static function code_challenge( $verifier ) {
		if ( ! preg_match( self::VERIFIER, (string) $verifier ) ) {
			throw new InvalidArgumentException( 'code_verifier must be 43 to 128 unreserved characters' );
		}
		return rtrim( strtr( base64_encode( hash( 'sha256', $verifier, true ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * A random URL-safe string from `$bytes` random bytes.
	 *
	 * @param int $bytes Entropy.
	 * @return string
	 */
	public static function random( $bytes ) {
		return rtrim( strtr( base64_encode( random_bytes( $bytes ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * A discovery document fetched from `$gate`, or why it is not one.
	 *
	 * @param mixed  $body Decoded JSON.
	 * @param string $gate The URL that was asked.
	 * @return array|string The document, or an error message.
	 */
	public static function parse_discovery( $body, $gate ) {
		$expected = self::origin_of( $gate );
		if ( null === $expected ) {
			return 'the gate URL must be https';
		}
		if ( ! is_array( $body ) ) {
			return 'not a naulon discovery document: body';
		}
		$endpoints = array( 'enforce_api', 'authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri' );
		foreach ( array_merge( array( 'issuer' ), $endpoints ) as $k ) {
			if ( ! isset( $body[ $k ] ) || ! is_string( $body[ $k ] ) ) {
				return 'not a naulon discovery document: ' . $k;
			}
		}
		if ( ! isset( $body['protocol'] ) || self::PROTOCOL !== $body['protocol'] ) {
			return 'not a naulon discovery document: protocol';
		}
		foreach ( $endpoints as $k ) {
			if ( null === self::origin_of( $body[ $k ] ) ) {
				return 'not a naulon discovery document: ' . $k;
			}
		}
		if ( ! isset( $body['challenge_path'] ) || self::CHALLENGE_PATH !== $body['challenge_path'] ) {
			return 'not a naulon discovery document: challenge_path';
		}
		$methods = isset( $body['code_challenge_methods_supported'] ) ? $body['code_challenge_methods_supported'] : null;
		if ( ! is_array( $methods ) || ! in_array( 'S256', $methods, true ) ) {
			return 'not a naulon discovery document: code_challenge_methods_supported';
		}
		if ( ! isset( $body['client_id_metadata_document_supported'] ) || true !== $body['client_id_metadata_document_supported'] ) {
			return 'not a naulon discovery document: client_id_metadata_document_supported';
		}
		// RFC 9207: every authorization response names its gate, and a response naming another is refused.
		if ( ! isset( $body['authorization_response_iss_parameter_supported'] ) || true !== $body['authorization_response_iss_parameter_supported'] ) {
			return 'not a naulon discovery document: authorization_response_iss_parameter_supported';
		}
		if ( ! isset( $body['network'] ) || ! is_array( $body['network'] ) || ! isset( $body['network']['member'] ) || ! is_bool( $body['network']['member'] ) ) {
			return 'not a naulon discovery document: network';
		}
		if ( $body['issuer'] !== $expected ) {
			return 'issuer ' . $body['issuer'] . ' does not match ' . $expected;
		}
		foreach ( array( 'enforce_api', 'token_endpoint', 'revocation_endpoint', 'jwks_uri' ) as $k ) {
			if ( self::origin_of( $body[ $k ] ) !== $expected ) {
				return $k . ' is not on ' . $expected;
			}
		}
		return $body;
	}
}
