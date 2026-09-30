<?php
/**
 * Verifies naulon's own signed origin pull — the one request this plugin must serve WITHOUT
 * charging or reporting it.
 *
 * When a publisher routes AI crawlers through naulon's gate at a crawler route (Cloudflare), the
 * gate charges the crawler and then fetches the page from this origin to hand it back. That
 * fetch carries an RFC 9421 Web Bot Auth signature, signed by the fleet's own agent, over exactly
 * this host, this path and this publisher's own tenant id. A runtime sitting behind that route
 * must recognise the pull and stand down — otherwise the same read is billed twice, once at the
 * route and once here.
 *
 * The tenant id is load-bearing, not decorative. The gate signs a pull for EVERY tenant it hosts,
 * so a signature alone only proves "some naulon tenant asked for this page" — any tenant can name
 * this site as its own `originUrl`. Binding the signature to `x-naulon-publisher` and checking it
 * against the id THIS site was configured with is what stops one tenant's pull being honoured as
 * if it were another's.
 *
 * This mirrors the reference verifier in packages/enforce/src/botAuth.ts and the "fleet-pull"
 * branch of packages/enforce/src/decide.ts, cut down to the one profile the gate's signer
 * (packages/shared/src/botAuthSign.ts) actually produces: `("@authority" "@path"
 * "x-naulon-publisher")`, `tag="web-bot-auth"`, an Ed25519 signature, and a plain-quoted
 * `Signature-Agent`.
 *
 * The trust boundary is narrow on purpose: the ONLY directory ever fetched is the one at the
 * configured fleet agent's own host. The Signature-Agent header names a directory, but that name
 * is attacker-supplied on every other request, so it is checked against the configured agent
 * BEFORE it is ever used to build a URL — never the other way round.
 *
 * Every failure returns false: an unparsable header, an unreachable directory, an unknown keyid,
 * an expired window, a wrong host, a bad signature, or a missing sodium extension. The cost of a
 * false negative is one origin pull gets charged like any other read, which the gate already
 * priced and will simply price again. The cost of a false positive would be a free read for
 * anyone able to forge a single header, so failing closed is the only acceptable posture.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Fleet_Pull {

	/** Where every Web Bot Auth key directory lives. */
	const WELL_KNOWN_PATH = '/.well-known/http-message-signatures-directory';

	/** How long a fetched directory is trusted before asking again. */
	const DIRECTORY_CACHE_TTL = 600;

	/** The directory fetch's own budget — this runs on the hot path of an origin fetch. */
	const DIRECTORY_FETCH_TIMEOUT = 3;

	/** Seconds between two rotation-grace refreshes, which a request's own keyid can trigger. */
	const ROTATION_REFRESH_INTERVAL = 60;

	/** Seconds a failed directory fetch waits before the next try. */
	const FETCH_FAILURE_BACKOFF = 10;

	/** Clock tolerance either side of created/expires. */
	const MAX_CLOCK_SKEW = 60;

	/** Cap on the signed window itself, tighter than the general 24h web-bot-auth ceiling — this
	 *  profile's signer defaults to a 60s window, so an hour is already generous slack. */
	const MAX_VALIDITY_SECONDS = 3600;

	/**
	 * The WordPress-facing entry point. Resolves (and caches) the fleet agent's own key
	 * directory, then hands the request to the pure verifier below.
	 *
	 * @param array  $headers         Request headers: lowercase names, raw values.
	 * @param string $host            The Host this request was served on.
	 * @param string $path            The request path, no query string.
	 * @param string $fleet_agent     The bare host naming the fleet's signing identity, from the
	 *                                control plane's `enforcement.fleetAgent`. Empty disables the
	 *                                rule.
	 * @param string $fleet_publisher This site's tenant id on the fleet, from
	 *                                `enforcement.fleetPublisher`. Empty disables the rule — a
	 *                                signature alone only proves SOME tenant signed it, never that
	 *                                it was signed for THIS one.
	 * @return bool
	 */
	public static function verify( array $headers, $host, $path, $fleet_agent, $fleet_publisher ) {
		if ( '' === $fleet_agent || '' === $fleet_publisher || ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
			return false;
		}

		$entry = self::parse_signature_input( self::header_value( $headers, 'signature-input' ) );
		if ( null === $entry ) {
			return false;
		}

		if ( ! self::precheck( $entry, $headers, $fleet_agent, $fleet_publisher, time() ) ) {
			return false;
		}

		$directory  = self::cached_directory( $fleet_agent );
		$was_cached = null !== $directory;
		if ( null === $directory ) {
			$directory = self::refresh_directory( $fleet_agent );
		}
		if ( null === $directory ) {
			return false;
		}
		if ( $was_cached && ! isset( $directory[ $entry['keyid'] ] ) ) {
			// Rotation grace: the cached copy may predate a key the operator just added. Once a
			// minute at most, because the keyid is whatever the request says it is.
			$rotate = self::directory_transient_key( $fleet_agent ) . '_rotate';
			if ( false === get_transient( $rotate ) ) {
				set_transient( $rotate, 1, self::ROTATION_REFRESH_INTERVAL );
				$directory = self::refresh_directory( $fleet_agent ) ?? $directory;
			}
		}

		return self::verify_parsed( $entry, $headers, $host, $path, $fleet_agent, $fleet_publisher, $directory, time() );
	}

	/**
	 * The pure core: no WordPress function, no network call. Everything from here reachable runs
	 * under plain `php`, which is what lets the crypto and structured-field parsing be tested
	 * without wp-env. A caller supplies the directory it already resolved and the clock to check
	 * against.
	 *
	 * @param array  $headers         Request headers: lowercase names, raw values.
	 * @param string $host            The Host this request was served on.
	 * @param string $path            The request path, no query string.
	 * @param string $fleet_agent     The bare host naming the fleet's signing identity.
	 * @param string $fleet_publisher This site's tenant id on the fleet.
	 * @param array  $directory       keyid (RFC 7638 thumbprint) => base64url Ed25519 public key.
	 * @param int    $now             Unix time, injectable for tests.
	 * @return bool
	 */
	public static function verify_with_directory( array $headers, $host, $path, $fleet_agent, $fleet_publisher, array $directory, $now ) {
		if ( '' === $fleet_agent || '' === $fleet_publisher || ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
			return false;
		}
		$entry = self::parse_signature_input( self::header_value( $headers, 'signature-input' ) );
		if ( null === $entry ) {
			return false;
		}
		return self::verify_parsed( $entry, $headers, $host, $path, $fleet_agent, $fleet_publisher, $directory, $now );
	}

	/**
	 * Every check that needs no key: the profile, the window, the agent and the tenant. Run before
	 * the directory is fetched, so a request that could never verify cannot make this site call out.
	 *
	 * @param array  $entry           Parsed Signature-Input entry.
	 * @param array  $headers         Request headers, lowercased keys.
	 * @param string $fleet_agent     Configured fleet agent host.
	 * @param string $fleet_publisher Configured tenant id.
	 * @param int    $now             Unix seconds.
	 * @return bool
	 */
	private static function precheck( array $entry, array $headers, $fleet_agent, $fleet_publisher, $now ) {
		if ( 'web-bot-auth' !== $entry['tag'] ) {
			return false;
		}
		// The covered set is exactly ("@authority" "@path" "x-naulon-publisher"), in that order —
		// the one shape the signer emits when it signs a path plus this header. Anything
		// narrower (no @path, no x-naulon-publisher) or wider is refused: it is either not this
		// profile, not bound to this exact resource, or not bound to any tenant at all.
		if ( array( '@authority', '@path', 'x-naulon-publisher' ) !== $entry['components'] ) {
			return false;
		}
		if ( null === $entry['created'] || null === $entry['expires'] || null === $entry['keyid'] || '' === $entry['keyid'] ) {
			return false;
		}
		if ( $entry['created'] > $now + self::MAX_CLOCK_SKEW ) {
			return false;
		}
		if ( $entry['expires'] < $now - self::MAX_CLOCK_SKEW ) {
			return false;
		}
		if ( ( $entry['expires'] - $entry['created'] ) > self::MAX_VALIDITY_SECONDS ) {
			return false;
		}

		// The agent identity is trusted ONLY when it names the exact host this plugin was
		// configured to trust. This check happens before the directory the request itself points
		// at is ever consulted — the directory used below always comes from $fleet_agent, never
		// from a value this header supplies.
		$agent_host = self::parse_signature_agent( self::header_value( $headers, 'signature-agent' ) );
		if ( null === $agent_host || strtolower( $agent_host ) !== strtolower( $fleet_agent ) ) {
			return false;
		}

		// The pull is trusted only when it was signed for THIS tenant. The gate signs a pull for
		// every tenant it hosts, so a valid signature over the right host and path still proves
		// nothing about WHICH tenant it was decided for — any tenant can name this site as its own
		// origin. The value compared here is the same one the base line below is built from, so a
		// header swapped in after signing is caught by the signature itself, never by this check.
		$publisher_header = trim( self::header_value( $headers, 'x-naulon-publisher' ) );
		if ( '' === $publisher_header || $publisher_header !== $fleet_publisher ) {
			return false;
		}

		return true;
	}

	/**
	 * Shared by both entry points once Signature-Input has parsed.
	 *
	 * @param array  $entry           Parsed Signature-Input entry (see parse_signature_input()).
	 * @param array  $headers         Request headers: lowercase names, raw values.
	 * @param string $host            The Host this request was served on.
	 * @param string $path            The request path, no query string.
	 * @param string $fleet_agent     The configured fleet agent host.
	 * @param string $fleet_publisher This site's configured tenant id.
	 * @param array  $directory       keyid => base64url Ed25519 public key.
	 * @param int    $now             Unix time.
	 * @return bool
	 */
	private static function verify_parsed( array $entry, array $headers, $host, $path, $fleet_agent, $fleet_publisher, array $directory, $now ) {
		if ( ! self::precheck( $entry, $headers, $fleet_agent, $fleet_publisher, $now ) ) {
			return false;
		}
		// The same value precheck compared, so the base below signs what was checked.
		$publisher_header = trim( self::header_value( $headers, 'x-naulon-publisher' ) );

		if ( ! isset( $directory[ $entry['keyid'] ] ) ) {
			return false;
		}
		$public_key = self::base64url_decode( $directory[ $entry['keyid'] ] );
		if ( false === $public_key || 32 !== strlen( $public_key ) ) {
			return false;
		}

		$sig_bytes = self::parse_signature_bytes( self::header_value( $headers, 'signature' ), $entry['label'] );
		if ( null === $sig_bytes || 64 !== strlen( $sig_bytes ) ) {
			return false;
		}

		$base = '"@authority": ' . strtolower( (string) $host ) . "\n"
			. '"@path": ' . self::path_only( $path ) . "\n"
			. '"x-naulon-publisher": ' . $publisher_header . "\n"
			. '"@signature-params": ' . $entry['raw_params'];

		return sodium_crypto_sign_verify_detached( $sig_bytes, $base, $public_key );
	}

	/**
	 * @param array  $headers Lowercase-keyed header map.
	 * @param string $name    Lowercase header name.
	 * @return string
	 */
	private static function header_value( array $headers, $name ) {
		return isset( $headers[ $name ] ) ? (string) $headers[ $name ] : '';
	}

	/**
	 * @param string $path Raw request path, possibly carrying a query string.
	 * @return string
	 */
	private static function path_only( $path ) {
		$path = (string) $path;
		$q    = strpos( $path, '?' );
		return false === $q ? $path : substr( $path, 0, $q );
	}

	/* ------------------------------------------------------------------ *
	 * Structured-field parsing — the minimal subset the three web-bot-auth
	 * headers use. Hand-rolled to match the RFC 8941 grammar the reference
	 * TypeScript verifier (botAuth.ts) implements, not a general SF library.
	 * ------------------------------------------------------------------ */

	/**
	 * Parse a `Signature-Input` value and return the first dictionary member tagged
	 * `web-bot-auth`, or null when none parses or none matches.
	 *
	 * @param string $value Header value.
	 * @return array|null {label, components, created, expires, keyid, tag, raw_params}
	 */
	private static function parse_signature_input( $value ) {
		$value = (string) $value;
		$len   = strlen( $value );
		$i     = 0;

		while ( $i < $len ) {
			self::skip_sp( $value, $i );
			$label = self::take_key( $value, $i, $len );
			if ( null === $label || $i >= $len || '=' !== $value[ $i ] ) {
				return null;
			}
			++$i;
			$member_start = $i;
			if ( $i >= $len || '(' !== $value[ $i ] ) {
				return null;
			}
			++$i;

			$components = array();
			for ( ;; ) {
				self::skip_sp( $value, $i );
				if ( $i >= $len ) {
					return null;
				}
				if ( ')' === $value[ $i ] ) {
					++$i;
					break;
				}
				if ( '"' !== $value[ $i ] ) {
					return null;
				}
				++$i;
				$name_start = $i;
				while ( $i < $len && '"' !== $value[ $i ] ) {
					++$i;
				}
				if ( $i >= $len ) {
					return null;
				}
				$components[] = substr( $value, $name_start, $i - $name_start );
				++$i; // closing quote
				// A component `;key=` parameter — this profile signs none, but tolerate one rather
				// than refuse a signature over an unrelated detail of the grammar.
				while ( $i < $len && ';' === $value[ $i ] ) {
					++$i;
					self::skip_sp( $value, $i );
					self::take_key( $value, $i, $len );
					if ( $i < $len && '=' === $value[ $i ] ) {
						++$i;
						if ( $i < $len && '"' === $value[ $i ] ) {
							++$i;
							while ( $i < $len && '"' !== $value[ $i ] ) {
								++$i;
							}
							if ( $i < $len ) {
								++$i;
							}
						} else {
							while ( $i < $len && ! in_array( $value[ $i ], array( ';', ')', ',', ' ' ), true ) ) {
								++$i;
							}
						}
					}
				}
			}

			$params = self::parse_sf_params( $value, $i, $len );
			if ( null === $params ) {
				return null;
			}
			$raw_params = substr( $value, $member_start, $i - $member_start );

			if ( isset( $params['tag'] ) && 'web-bot-auth' === $params['tag'] ) {
				return array(
					'label'      => $label,
					'components' => $components,
					'created'    => isset( $params['created'] ) && is_int( $params['created'] ) ? $params['created'] : null,
					'expires'    => isset( $params['expires'] ) && is_int( $params['expires'] ) ? $params['expires'] : null,
					'keyid'      => isset( $params['keyid'] ) ? $params['keyid'] : null,
					'tag'        => $params['tag'],
					'raw_params' => $raw_params,
				);
			}

			self::skip_sp( $value, $i );
			if ( $i >= $len || ',' !== $value[ $i ] ) {
				return null;
			}
			++$i;
		}
		return null;
	}

	/**
	 * `;key=value` parameters following a dictionary member, up to (but not including) whatever
	 * follows — `,` (next member) or end of string. Advances `$i` past what it consumed.
	 *
	 * @param string $value Header value.
	 * @param int    $i     Cursor, by reference.
	 * @param int    $len   Length of $value.
	 * @return array|null Parsed params, keyed by name.
	 */
	private static function parse_sf_params( $value, &$i, $len ) {
		$out = array();
		while ( $i < $len && ';' === $value[ $i ] ) {
			++$i;
			self::skip_sp( $value, $i );
			$key = self::take_key( $value, $i, $len );
			if ( null === $key ) {
				return null;
			}
			if ( $i < $len && '=' === $value[ $i ] ) {
				++$i;
				if ( $i < $len && '"' === $value[ $i ] ) {
					++$i;
					$start = $i;
					while ( $i < $len && '"' !== $value[ $i ] ) {
						++$i;
					}
					if ( $i >= $len ) {
						return null;
					}
					$out[ $key ] = substr( $value, $start, $i - $start );
					++$i;
				} elseif ( $i < $len && ( '-' === $value[ $i ] || ctype_digit( $value[ $i ] ) ) ) {
					$start = $i;
					if ( '-' === $value[ $i ] ) {
						++$i;
					}
					while ( $i < $len && ctype_digit( $value[ $i ] ) ) {
						++$i;
					}
					$out[ $key ] = (int) substr( $value, $start, $i - $start );
				} else {
					return null;
				}
			} else {
				$out[ $key ] = true;
			}
		}
		return $out;
	}

	/**
	 * sf-key: lowercase alnum plus `_-.*`.
	 *
	 * @param string $value Header value.
	 * @param int    $i     Cursor, by reference.
	 * @param int    $len   Length of $value.
	 * @return string|null
	 */
	private static function take_key( $value, &$i, $len ) {
		$start = $i;
		while ( $i < $len && preg_match( '/[a-z0-9_\-.*]/', $value[ $i ] ) ) {
			++$i;
		}
		return $i > $start ? substr( $value, $start, $i - $start ) : null;
	}

	/**
	 * @param string $value Header value.
	 * @param int    $i     Cursor, by reference.
	 * @return void
	 */
	private static function skip_sp( $value, &$i ) {
		$len = strlen( $value );
		while ( $i < $len && ( ' ' === $value[ $i ] || "\t" === $value[ $i ] ) ) {
			++$i;
		}
	}

	/**
	 * Parse a `Signature` header value and return the raw signature bytes for one label, or null.
	 *
	 * @param string $value Header value.
	 * @param string $label Dictionary label to extract (matches Signature-Input's label).
	 * @return string|null Raw bytes.
	 */
	private static function parse_signature_bytes( $value, $label ) {
		$value  = (string) $value;
		$needle = $label . '=:';
		$pos    = strpos( $value, $needle );
		if ( false === $pos ) {
			return null;
		}
		$start = $pos + strlen( $needle );
		$end   = strpos( $value, ':', $start );
		if ( false === $end ) {
			return null;
		}
		$decoded = base64_decode( substr( $value, $start, $end - $start ), true );
		return false === $decoded ? null : $decoded;
	}

	/**
	 * Parse a `Signature-Agent` value into its bare host. Accepts the profile's plain quoted
	 * string, with or without a scheme.
	 *
	 * @param string $raw Header value.
	 * @return string|null
	 */
	private static function parse_signature_agent( $raw ) {
		$raw = trim( (string) $raw );
		if ( strlen( $raw ) < 2 || '"' !== $raw[0] || '"' !== substr( $raw, -1 ) ) {
			return null;
		}
		$inner = substr( $raw, 1, -1 );
		if ( '' === $inner ) {
			return null;
		}
		$scheme_at = strpos( $inner, '://' );
		$after     = false !== $scheme_at ? substr( $inner, $scheme_at + 3 ) : $inner;
		$slash_at  = strpos( $after, '/' );
		$host_port = false === $slash_at ? $after : substr( $after, 0, $slash_at );
		$colon_at  = strpos( $host_port, ':' );
		$host      = false === $colon_at ? $host_port : substr( $host_port, 0, $colon_at );
		return '' === $host ? null : strtolower( $host );
	}

	/* ------------------------------------------------------------------ *
	 * Key directory: fetch, validate, cache.
	 * ------------------------------------------------------------------ */

	/**
	 * @param string $fleet_agent Bare host.
	 * @return string
	 */
	private static function directory_transient_key( $fleet_agent ) {
		return 'naulon_fleet_dir_' . md5( strtolower( (string) $fleet_agent ) );
	}

	/**
	 * @param string $fleet_agent Bare host.
	 * @return array|null keyid => base64url x, or null when nothing is cached.
	 */
	private static function cached_directory( $fleet_agent ) {
		$cached = get_transient( self::directory_transient_key( $fleet_agent ) );
		return is_array( $cached ) ? $cached : null;
	}

	/**
	 * Fetch the directory fresh and cache it on success. Leaves a stale cache entry alone on
	 * failure, so a momentary blip does not evict a directory that was fine a minute ago.
	 *
	 * @param string $fleet_agent Bare host.
	 * @return array|null
	 */
	private static function refresh_directory( $fleet_agent ) {
		// A failed fetch backs off briefly, so a directory that is down is not asked again by every
		// request in the meantime. Only a failure sets it: a success must never delay the next.
		$backoff = self::directory_transient_key( $fleet_agent ) . '_backoff';
		if ( false !== get_transient( $backoff ) ) {
			return null;
		}
		$directory = self::fetch_directory( $fleet_agent );
		if ( null === $directory ) {
			set_transient( $backoff, 1, self::FETCH_FAILURE_BACKOFF );
			return null;
		}
		set_transient( self::directory_transient_key( $fleet_agent ), $directory, self::DIRECTORY_CACHE_TTL );
		return $directory;
	}

	/**
	 * GET the fleet agent's own key directory. Never follows a redirect — the host is configured,
	 * not attacker-supplied, but the directory it serves still is.
	 *
	 * @param string $fleet_agent Bare host.
	 * @return array|null keyid (RFC 7638 thumbprint) => base64url Ed25519 x.
	 */
	private static function fetch_directory( $fleet_agent ) {
		$response = wp_remote_get(
			'https://' . $fleet_agent . self::WELL_KNOWN_PATH,
			array(
				'timeout'     => self::DIRECTORY_FETCH_TIMEOUT,
				'redirection' => 0,
			)
		);
		if ( is_wp_error( $response ) ) {
			return null;
		}
		if ( 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
			return null;
		}
		$decoded = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $decoded ) || ! isset( $decoded['keys'] ) || ! is_array( $decoded['keys'] ) ) {
			return null;
		}
		$keys = array();
		foreach ( $decoded['keys'] as $key ) {
			if ( ! is_array( $key ) || ! isset( $key['kty'], $key['crv'], $key['x'] ) ) {
				continue;
			}
			if ( 'OKP' !== $key['kty'] || 'Ed25519' !== $key['crv'] || ! is_string( $key['x'] ) || '' === $key['x'] ) {
				continue;
			}
			$keys[ self::thumbprint( $key['x'] ) ] = $key['x'];
		}
		return empty( $keys ) ? null : $keys;
	}

	/**
	 * RFC 7638 JWK thumbprint of an Ed25519 public key: SHA-256 over the required members in
	 * lexicographic order (crv, kty, x), which is also their alphabetical order — no sort needed.
	 * Byte-compatible with the signer's own `botAuthThumbprint` and the verifier's `jwkThumbprint`.
	 *
	 * @param string $x Base64url raw public key.
	 * @return string
	 */
	private static function thumbprint( $x ) {
		$hash = hash( 'sha256', '{"crv":"Ed25519","kty":"OKP","x":"' . $x . '"}', true );
		return rtrim( strtr( base64_encode( $hash ), '+/', '-_' ), '=' );
	}

	/**
	 * @param string $data Base64url text.
	 * @return string|false Raw bytes, or false when the input is not valid base64.
	 */
	private static function base64url_decode( $data ) {
		$data = strtr( (string) $data, '-_', '+/' );
		$pad  = strlen( $data ) % 4;
		if ( 0 !== $pad ) {
			$data .= str_repeat( '=', 4 - $pad );
		}
		return base64_decode( $data, true );
	}
}
