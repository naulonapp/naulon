<?php
/**
 * Does the caller's address back the crawler its user-agent names? A port of
 * packages/enforce/src/identity.ts, held to the same answers by the shared fixture file
 * (tests/unit/IdentityFixturesTest.php).
 *
 * check() never accuses on missing evidence: no usable client IP, no ranges, stale ranges or a
 * source not eligible to accuse all read `unverified`. Only classify() acts on the answer, and only
 * to withhold an allowlist's free read from an armed, forged claim.
 *
 * This plugin has no Web Bot Auth step, so a claim is never `signature` here.
 *
 * Pure functions, no WordPress calls.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Identity {

	/**
	 * The operator table used when no ranges document is stored: enough to recognise a claim and
	 * report it `unverified`. Mirrors CRAWLER_PROOF in packages/shared/src/crawlerProof.ts through
	 * the fixture file's `operators`, which both test suites hold it to.
	 */
	const PROOF = array(
		array( 'id' => 'google', 'operator' => 'Google', 'fragments' => array( 'googlebot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'bing', 'operator' => 'Microsoft', 'fragments' => array( 'bingbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'duckduckgo', 'operator' => 'DuckDuckGo', 'fragments' => array( 'duckduckbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'apple', 'operator' => 'Apple', 'fragments' => array( 'applebot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'openai-gptbot', 'operator' => 'OpenAI', 'fragments' => array( 'gptbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'openai-searchbot', 'operator' => 'OpenAI', 'fragments' => array( 'oai-searchbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'openai-chatgpt-user', 'operator' => 'OpenAI', 'fragments' => array( 'chatgpt-user' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'anthropic', 'operator' => 'Anthropic', 'fragments' => array( 'claudebot', 'claude-user', 'claude-searchbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'commoncrawl', 'operator' => 'Common Crawl', 'fragments' => array( 'ccbot' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'mistral', 'operator' => 'Mistral', 'fragments' => array( 'mistralai-user' ), 'kind' => 'ranges', 'forgedEligible' => true ),
		array( 'id' => 'perplexity-bot', 'operator' => 'Perplexity', 'fragments' => array( 'perplexitybot' ), 'kind' => 'ranges', 'forgedEligible' => false ),
		array( 'id' => 'perplexity-user', 'operator' => 'Perplexity', 'fragments' => array( 'perplexity-user' ), 'kind' => 'ranges', 'forgedEligible' => false ),
		array( 'id' => 'amazon', 'operator' => 'Amazon', 'fragments' => array( 'amazonbot', 'amzn-user' ), 'kind' => 'none', 'forgedEligible' => false ),
		array( 'id' => 'exa', 'operator' => 'Exa', 'fragments' => array( 'exasearchbot' ), 'kind' => 'signature', 'forgedEligible' => false ),
		array( 'id' => 'meta', 'operator' => 'Meta', 'fragments' => array( 'meta-externalagent', 'meta-externalfetcher' ), 'kind' => 'none', 'forgedEligible' => false ),
		array( 'id' => 'bytedance', 'operator' => 'ByteDance', 'fragments' => array( 'bytespider' ), 'kind' => 'none', 'forgedEligible' => false ),
	);

	/** Severity order: the overall check is the worst claim's. */
	const RANK = array(
		'signature'   => 0,
		'ip-verified' => 1,
		'unverified'  => 2,
		'forged'      => 3,
	);

	/**
	 * Every operator a user-agent names, with the fragment that named it, in table order.
	 *
	 * @param string     $ua       User-agent.
	 * @param array|null $compiled Naulon_Ranges::compile() output, or null.
	 * @return array List of ['id', 'operator', 'fragment'].
	 */
	public static function claims_in( $ua, $compiled ) {
		$lower = strtolower( (string) $ua );
		$table = null === $compiled ? self::PROOF : $compiled['table'];
		$out   = array();
		foreach ( $table as $row ) {
			foreach ( $row['fragments'] as $f ) {
				if ( '' !== $f && false !== strpos( $lower, $f ) ) {
					$out[] = array(
						'id'       => $row['id'],
						'operator' => $row['operator'],
						'fragment' => $f,
					);
					break;
				}
			}
		}
		return $out;
	}

	/**
	 * Check each crawler claim in the user-agent against the caller's address.
	 *
	 * @param string      $ua        User-agent.
	 * @param array|null  $compiled  Naulon_Ranges::compile() output, or null.
	 * @param string|null $client_ip The caller's address as Naulon_Agent::client_ip() derived it.
	 * @param int         $now       Unix seconds.
	 * @return array|null ['check', 'claims' => [['operator_id', 'operator', 'fragment', 'check']]], or null when no crawler is named.
	 */
	public static function check( $ua, $compiled, $client_ip, $now ) {
		$found = self::claims_in( $ua, $compiled );
		if ( empty( $found ) ) {
			return null;
		}
		$ip = ( null !== $client_ip && '' !== $client_ip ) ? Naulon_Ip::parse_client_address( $client_ip ) : null;
		// A proxy's address is never the caller's: a real crawler does not originate inside a CDN's
		// own ranges, so an address there means the server read the proxy instead of the caller.
		$proxies = null === $compiled ? array() : array_values( $compiled['proxies'] );
		$usable  = null !== $ip && Naulon_Ip::usable( $ip, $proxies );

		$claims = array();
		$worst  = 'signature';
		foreach ( $found as $f ) {
			$op    = ( null !== $compiled && isset( $compiled['operators'][ $f['id'] ] ) ) ? $compiled['operators'][ $f['id'] ] : null;
			$check = self::claim_check( $op, $usable ? $ip : null, $now );

			$claims[] = array(
				'operator_id' => $f['id'],
				'operator'    => null !== $op ? $op['operator'] : $f['operator'],
				'fragment'    => $f['fragment'],
				'check'       => $check,
			);
			if ( self::RANK[ $check ] > self::RANK[ $worst ] ) {
				$worst = $check;
			}
		}
		return array(
			'check'  => $worst,
			'claims' => $claims,
		);
	}

	/**
	 * The claim that set the overall check: the one an audit row should name.
	 *
	 * @param array $result From check().
	 * @return array|null
	 */
	public static function deciding_claim( array $result ) {
		foreach ( $result['claims'] as $c ) {
			if ( $c['check'] === $result['check'] ) {
				return $c;
			}
		}
		return null;
	}

	/**
	 * The identity check as a publisher reads it on Diagnostics, or '' when no crawler was named.
	 * Stored in the local decision log beside the reason, in English like every other reason there.
	 *
	 * @param array|null $result From check().
	 * @return string
	 */
	public static function describe( $result ) {
		if ( ! is_array( $result ) ) {
			return '';
		}
		$claim = self::deciding_claim( $result );
		$who   = null === $claim ? 'the named crawler' : $claim['operator'];
		switch ( $result['check'] ) {
			case 'ip-verified':
				return sprintf( "address inside %s's published ranges", $who );
			case 'forged':
				return sprintf( "address outside %s's published ranges", $who );
			case 'signature':
				return sprintf( 'signed by %s', $who );
			default:
				return sprintf( 'address not checked (no usable client address or no current ranges for %s)', $who );
		}
	}

	/**
	 * Classify with the identity check applied. With mode `off` this is Naulon_Agent::classify
	 * unchanged and no claim is checked.
	 *
	 * @param array       $signals   Naulon_Agent::classify() signals.
	 * @param array       $policy    Naulon_Agent::classify() policy.
	 * @param string      $mode      'auto' or 'off'.
	 * @param array|null  $compiled  Naulon_Ranges::compile() output, or null.
	 * @param string|null $client_ip The caller's address.
	 * @param int         $now       Unix seconds.
	 * @param array       $armed     Operator ids this site is armed for.
	 * @return array ['verdict' => array, 'identity' => ?array, 'forged_claim' => ?array]
	 */
	public static function classify( array $signals, array $policy, $mode, $compiled, $client_ip, $now, array $armed ) {
		if ( 'off' === $mode ) {
			return array(
				'verdict'      => Naulon_Agent::classify( $signals, $policy ),
				'identity'     => null,
				'forged_claim' => null,
			);
		}
		$ua       = isset( $signals['user_agent'] ) ? (string) $signals['user_agent'] : '';
		$identity = self::check( $ua, $compiled, $client_ip, $now );
		$forged   = null;
		if ( null !== $identity ) {
			foreach ( $identity['claims'] as $c ) {
				if ( 'forged' === $c['check'] && in_array( $c['operator_id'], $armed, true ) ) {
					$forged = $c;
					break;
				}
			}
		}
		if ( null !== $forged ) {
			$signals['forged_claim'] = array(
				'operator_id' => $forged['operator_id'],
				'operator'    => $forged['operator'],
				'fragment'    => $forged['fragment'],
			);
		}
		return array(
			'verdict'      => Naulon_Agent::classify( $signals, $policy ),
			'identity'     => $identity,
			'forged_claim' => $forged,
		);
	}

	/**
	 * One claim's check.
	 *
	 * @param array|null $op  The compiled operator, or null when the ranges do not list it.
	 * @param array|null $ip  The parsed caller address, or null when it is not usable.
	 * @param int        $now Unix seconds.
	 * @return string
	 */
	private static function claim_check( $op, $ip, $now ) {
		if ( null === $op || 'ranges' !== $op['kind'] || null === $ip ) {
			return 'unverified';
		}
		if ( Naulon_Ip::in_any( $ip, $op['set'] ) ) {
			return 'ip-verified';
		}
		if ( ! $op['eligible'] || ! Naulon_Ranges::is_fresh( $op, $now ) ) {
			return 'unverified';
		}
		return 'forged';
	}
}
