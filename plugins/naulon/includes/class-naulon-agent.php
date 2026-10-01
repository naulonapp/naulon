<?php
/**
 * Human vs. machine classification — the hinge of the whole thesis, and the ONE piece of the
 * decision path that has to live here rather than in the control plane.
 *
 * Everything else this plugin decides is delegated: the price and the 402 come from
 * `/_naulon/quote?build=402`, settlement from `/_naulon/verify`, license entitlement from
 * `/_naulon/license/check`. Those are all one implementation, called over HTTP. Classification
 * cannot be, because it runs on every single request including every human one — asking a
 * remote service "is this a human?" would put a network round trip in front of every reader,
 * leak every visitor's user agent off-site, and break the site whenever the service blinked.
 * So it is mirrored here, deliberately, and guarded by a parity test that reads the TypeScript
 * source directly (tests/unit/ClassifierParityTest.php). If the upstream list moves, that test
 * fails — the copy cannot drift quietly.
 *
 * The asymmetry that governs every choice below, inherited verbatim:
 *
 *   - False positive (human flagged as agent) → a human hits a paywall. This breaks the
 *     promise the whole product rests on. Worst outcome. Bias away from it.
 *   - False negative (agent flagged as human) → a crawler reads free. We lose a micro-toll.
 *     Cheap. Tolerable.
 *
 * So: only charge when confident. Ambiguity reads as human, forever.
 *
 * Web Bot Auth (the Ed25519 signature that proves WHO is calling) is NOT verified here. In the
 * gate it both frees a verified allowlisted crawler and charges a verified agent behind a
 * browser-shaped UA. Skipping it costs us the second case only — an agent that hides behind a
 * browser UA reads free, which is the tolerable direction. It never causes a human to be
 * charged.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Agent {

	/**
	 * Obvious crawler/agent UA fragments — a weak, spoofable signal, used only after the
	 * stronger ones. MIRRORS `KNOWN_AGENT_UA` in packages/enforce/src/agentDetect.ts and is
	 * pinned to it by ClassifierParityTest.
	 *
	 * Two kinds of machine read are charged: training/bulk crawlers, and user-triggered
	 * assistant fetches (the citation moment itself). Both are machine-only UAs, so charging
	 * them cannot toll a human.
	 *
	 * Pure search-indexer UAs (googlebot, bingbot, oai-searchbot, claude-searchbot,
	 * meta-webindexer, amzn-searchbot…) are deliberately absent: tolling a search crawler
	 * silently deindexes the publisher, which is the opposite of what they want.
	 */
	const KNOWN_AGENT_UA = array(
		'gptbot',
		'chatgpt-user',
		'claudebot',
		'claude-user',
		'perplexitybot',
		'perplexity-user',
		'ccbot',
		'bytespider',
		'amazonbot',
		'applebot-extended',
		'meta-externalagent',
		'meta-externalfetcher',
		'amzn-user',
		'mistralai-user',
		// Exa. Documented by its operator as a search engine, and deliberately NOT treated as
		// one: a single token does both the indexing and the on-demand /contents fetch an agent
		// pays Exa for, so the tollable half cannot be separated from the indexing half. See the
		// divergence note on its CRAWLER_REGISTRY row upstream before moving it.
		'exasearchbot',
		'python-requests',
		'node-fetch',
		'axios',
		'curl',
		'wget',
		'langchain',
	);

	/**
	 * Classify a request.
	 *
	 * The order is load-bearing and matches the kernel exactly: declared intent, then the
	 * publisher's allowlist, then the publisher's charge list, then the built-in list, then
	 * browser shape, then the human default.
	 *
	 * @param array $signals {
	 *     @type string $user_agent         The UA string.
	 *     @type bool   $has_payment_header Caller already speaks x402.
	 *     @type string $declared_agent_id  X-Naulon-Agent value, or ''.
	 *     @type string $accept             Accept header.
	 *     @type array  $headers            Lower-cased header names present on the request.
	 *     @type array  $forged_claim       Optional. Set by Naulon_Identity::classify only.
	 * }
	 * @param array $policy {
	 *     @type string[] $seo_allowlist Fragments that read FREE for this publisher.
	 *     @type string[] $charge_list   Fragments this publisher explicitly tolls.
	 * }
	 * @return array {kind: 'human'|'agent', reason: string, confidence: float}
	 */
	public static function classify( array $signals, array $policy = array() ) {
		$ua          = isset( $signals['user_agent'] ) ? (string) $signals['user_agent'] : '';
		$ua_lower    = strtolower( $ua );
		$accept      = isset( $signals['accept'] ) ? (string) $signals['accept'] : '';
		$headers     = isset( $signals['headers'] ) && is_array( $signals['headers'] ) ? $signals['headers'] : array();
		$allow_list  = isset( $policy['seo_allowlist'] ) && is_array( $policy['seo_allowlist'] ) ? $policy['seo_allowlist'] : array();
		$charge_list = isset( $policy['charge_list'] ) && is_array( $policy['charge_list'] ) ? $policy['charge_list'] : array();

		// 1) Declared intent — the strongest signal, and the one that sidesteps the UA arms
		//    race entirely. An agent that presents a payment header is telling us what it is.
		if ( ! empty( $signals['has_payment_header'] ) ) {
			return self::verdict( 'agent', 'presented x402 payment header', 0.99 );
		}
		if ( ! empty( $signals['declared_agent_id'] ) ) {
			return self::verdict( 'agent', 'declared agent id ' . $signals['declared_agent_id'], 0.95 );
		}

		// 2) The publisher's SEO allowlist wins over everything below it — never toll the
		//    crawlers a publisher needs for indexing, even when the UA also looks like a bot.
		//    Except a claim the caller's address contradicts on an armed site
		//    (Naulon_Identity::classify sets `forged_claim`): it earns nothing here, and nothing
		//    below may free it again, because a forged crawler is browser-shaped too.
		$allowed = self::match_fragment( $ua_lower, $allow_list );
		if ( null !== $allowed && ! empty( $signals['forged_claim'] ) ) {
			$f = $signals['forged_claim'];
			return array(
				'kind'       => 'agent',
				'identity'   => 'forged',
				'reason'     => sprintf( 'claimed "%s" from an address outside %s\'s published ranges', $f['fragment'], $f['operator'] ),
				'confidence' => 0.95,
			);
		}
		if ( null !== $allowed ) {
			return self::verdict( 'human', sprintf( 'seo allowlist matched "%s"', $allowed ), 0.9 );
		}

		// 2b) Publisher-charged fragments — after allow (allow wins on overlap), before the
		//     built-in list, so a publisher can charge something the default reads as human.
		$charged = self::match_fragment( $ua_lower, $charge_list );
		if ( null !== $charged ) {
			return self::verdict( 'agent', sprintf( 'publisher charge policy matched "%s"', $charged ), 0.8 );
		}

		// 3) Known-bot UA.
		$hit = self::match_fragment( $ua_lower, self::KNOWN_AGENT_UA );
		if ( null !== $hit ) {
			return self::verdict( 'agent', sprintf( 'user-agent matched "%s"', $hit ), 0.8 );
		}

		// 4) Browser-shaped ⇒ human.
		if ( false !== strpos( $accept, 'text/html' ) || isset( $headers['sec-fetch-mode'] ) ) {
			return self::verdict( 'human', 'browser-shaped request', 0.85 );
		}

		// 5) The ambiguous middle. Free, by design — see the asymmetry note.
		return self::verdict( 'human', 'ambiguous; defaulting to human (free)', 0.4 );
	}

	/**
	 * Build the signal bag from PHP superglobals. Isolated so the classifier itself stays a
	 * pure function that tests can drive without faking a request.
	 *
	 * @return array
	 */
	public static function signals_from_request() {
		$headers = array();
		foreach ( array_keys( $_SERVER ) as $key ) {
			if ( 0 === strpos( $key, 'HTTP_' ) ) {
				$headers[ strtolower( str_replace( '_', '-', substr( $key, 5 ) ) ) ] = true;
			}
		}

		$ua      = isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '';
		$signals = array(
			'user_agent'         => $ua,
			'accept'             => isset( $_SERVER['HTTP_ACCEPT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_ACCEPT'] ) ) : '',
			'has_payment_header' => isset( $_SERVER['HTTP_PAYMENT_SIGNATURE'] ),
			'declared_agent_id'  => isset( $_SERVER['HTTP_X_NAULON_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_X_NAULON_AGENT'] ) ) : '',
			'headers'            => $headers,
		);
		// The caller's address is read only when the user-agent names a crawler, so a person's
		// request never loads the ranges option. The built-in table is the pre-filter: a claim it
		// does not know cannot be checked anyway until the ranges name it.
		if ( ! empty( Naulon_Identity::claims_in( $ua, null ) ) ) {
			$settings             = Naulon_Settings::all();
			$signals['client_ip'] = self::client_ip(
				$_SERVER, // phpcs:ignore WordPress.Security.ValidatedSanitizedInput -- client_ip() reads only address headers and parses them.
				is_string( $settings['trusted_ip_header'] ) ? $settings['trusted_ip_header'] : '',
				Naulon_Ranges::instance()->current()
			);
		}
		return $signals;
	}

	/**
	 * The caller's address, as the identity check should read it. A header is believed only from
	 * a peer that could have set it, mirroring the gate's callerIp():
	 *   - the publisher's configured header (its first comma entry), when one is set;
	 *   - else CF-Connecting-IPv6 / CF-Connecting-IP, when REMOTE_ADDR is inside Cloudflare's
	 *     published ranges, because anyone can send those headers straight to the origin;
	 *   - else REMOTE_ADDR.
	 * A private or reserved result is returned as is; Naulon_Ip::usable() then reads it as
	 * unverified, which never charges anyone.
	 *
	 * @param array      $server         $_SERVER, or a test double.
	 * @param string     $trusted_header Stored setting in HTTP_ form, or ''.
	 * @param array|null $compiled       Naulon_Ranges::compile() output, or null.
	 * @return string|null
	 */
	public static function client_ip( array $server, $trusted_header, $compiled ) {
		$read = function ( $key ) use ( $server ) {
			if ( ! isset( $server[ $key ] ) || ! is_string( $server[ $key ] ) ) {
				return null;
			}
			// WordPress slashes $_SERVER (wp_magic_quotes). An address never holds a backslash, so
			// stripping them is safe on a value that was never slashed too.
			$first = trim( explode( ',', stripslashes( $server[ $key ] ) )[0] );
			return '' === $first ? null : $first;
		};
		if ( '' !== $trusted_header ) {
			// Cloudflare sends a pseudo-IPv4 in CF-Connecting-IP for an IPv6 caller, and the real
			// address beside it.
			if ( 'HTTP_CF_CONNECTING_IP' === $trusted_header ) {
				$v6 = $read( 'HTTP_CF_CONNECTING_IPV6' );
				if ( null !== $v6 ) {
					return $v6;
				}
			}
			return $read( $trusted_header );
		}
		$peer = $read( 'REMOTE_ADDR' );
		if ( null === $peer ) {
			return null;
		}
		if ( null !== $compiled && isset( $compiled['proxies']['cloudflare'] ) ) {
			$parsed = Naulon_Ip::parse( $peer );
			if ( null !== $parsed && Naulon_Ip::in_any( $parsed, $compiled['proxies']['cloudflare'] ) ) {
				$v6 = $read( 'HTTP_CF_CONNECTING_IPV6' );
				if ( null !== $v6 ) {
					return $v6;
				}
				$v4 = $read( 'HTTP_CF_CONNECTING_IP' );
				if ( null !== $v4 ) {
					return $v4;
				}
			}
		}
		return $peer;
	}

	/**
	 * First fragment found in the (already lower-cased) UA, else null. The one matching
	 * primitive every list above shares.
	 *
	 * @param string   $ua_lower  Lower-cased user agent.
	 * @param string[] $fragments Fragments to look for.
	 * @return string|null
	 */
	public static function match_fragment( $ua_lower, $fragments ) {
		if ( ! is_array( $fragments ) || '' === $ua_lower ) {
			return null;
		}
		foreach ( $fragments as $fragment ) {
			if ( ! is_string( $fragment ) || '' === $fragment ) {
				continue;
			}
			if ( false !== strpos( $ua_lower, strtolower( $fragment ) ) ) {
				return $fragment;
			}
		}
		return null;
	}

	/**
	 * @param string $kind       human|agent.
	 * @param string $reason     Why.
	 * @param float  $confidence 0..1.
	 * @return array
	 */
	private static function verdict( $kind, $reason, $confidence ) {
		return array(
			'kind'       => $kind,
			'reason'     => $reason,
			'confidence' => $confidence,
		);
	}
}
