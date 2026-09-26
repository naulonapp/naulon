<?php
/**
 * The publisher's dashboard rules, applied here: which crawlers are blocked, read free or charged,
 * which uses their stated terms refuse, and whether agent reads are free.
 *
 * The control plane sends them pre-resolved (`rules` in `/_naulon/enforce-config`), so nothing
 * here re-derives a rule. The refusal table is the crawler registry in order, each entry already
 * marked by the gate's own refusal function; this class only takes the first entry whose fragment
 * appears in the user agent, which is how the gate recognises a crawler too.
 *
 * It fails OPEN, like every other control-plane read in this plugin. No rules means the plugin
 * behaves exactly as it did before it knew about them: a reader is never refused because a
 * config fetch timed out.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

/**
 * Dashboard rules for this site.
 */
class Naulon_Rules {

	/** How long a fetched copy is used before asking again. A dashboard edit lands within this. */
	const TTL = 300;

	/** Transient holding the fresh copy. */
	const TRANSIENT = 'naulon_rules';

	/** Option holding the last good copy, served when a refresh fails. */
	const LAST_GOOD = 'naulon_rules_last_good';

	/** @var Naulon_Rules|null */
	private static $instance = null;

	/** @var array|null|false Memo for this request: false = not loaded yet. */
	private $memo = false;

	/**
	 * @return Naulon_Rules
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * The rules for this site, or null when none could be read.
	 *
	 * `$may_fetch` is false on a request that looks like a person. A human read must never wait on
	 * the control plane or write anything, so it uses whatever copy is already stored: the fresh
	 * one, else the last good one. Only a machine request, or the cron, refreshes it.
	 *
	 * @param bool $may_fetch Whether a missing fresh copy may be fetched now.
	 * @return array|null
	 */
	public function get( $may_fetch = true ) {
		if ( false !== $this->memo ) {
			return $this->memo;
		}
		$cached = get_transient( self::TRANSIENT );
		if ( is_array( $cached ) ) {
			$this->memo = self::normalize( $cached );
			return $this->memo;
		}
		if ( ! $may_fetch ) {
			$last = get_option( self::LAST_GOOD );
			// Not memoized: a later machine check in this request may still refresh.
			return is_array( $last ) ? self::normalize( $last ) : null;
		}
		return $this->refresh();
	}

	/**
	 * Fetch the rules now. Called on a machine request with no fresh copy, and by the cron so the
	 * copy a human request reads stays warm.
	 *
	 * @return array|null
	 */
	public function refresh() {
		$response = Naulon_Client::instance()->enforce_config( home_url( '/' ) );
		if ( $response['ok'] && is_array( $response['body'] ) && isset( $response['body']['rules'] ) && is_array( $response['body']['rules'] ) ) {
			$rules = $response['body']['rules'];
			set_transient( self::TRANSIENT, $rules, self::TTL );
			update_option( self::LAST_GOOD, $rules, false );
			$this->memo = self::normalize( $rules );
			return $this->memo;
		}
		// Stale beats nothing: a publisher who blocked a crawler yesterday still blocks it while
		// the control plane is unreachable. Retry sooner than a fresh copy would expire.
		$last = get_option( self::LAST_GOOD );
		if ( is_array( $last ) ) {
			set_transient( self::TRANSIENT, $last, 60 );
			$this->memo = self::normalize( $last );
			return $this->memo;
		}
		$this->memo = null;
		return null;
	}

	/** Forget the cached copy, so the next read asks the control plane. */
	public static function flush() {
		delete_transient( self::TRANSIENT );
	}

	/**
	 * Coerce a wire document into the shape the decisions below read. Anything malformed becomes
	 * the empty rule, never a crash in a request path.
	 *
	 * @param array $raw Wire document.
	 * @return array
	 */
	public static function normalize( array $raw ) {
		$list = static function ( $v ) {
			if ( ! is_array( $v ) ) {
				return array();
			}
			$out = array();
			foreach ( $v as $item ) {
				if ( is_string( $item ) && '' !== trim( $item ) ) {
					$out[] = strtolower( trim( $item ) );
				}
			}
			return $out;
		};
		$crawlers = array();
		$refuse   = isset( $raw['refuse'] ) && is_array( $raw['refuse'] ) ? $raw['refuse'] : array();
		if ( isset( $refuse['crawlers'] ) && is_array( $refuse['crawlers'] ) ) {
			foreach ( $refuse['crawlers'] as $row ) {
				if ( is_array( $row ) && isset( $row[0], $row[1] ) && is_string( $row[0] ) && '' !== $row[0] ) {
					$crawlers[] = array( strtolower( $row[0] ), true === $row[1] );
				}
			}
		}
		return array(
			'block'          => $list( isset( $raw['block'] ) ? $raw['block'] : null ),
			'allow'          => $list( isset( $raw['allow'] ) ? $raw['allow'] : null ),
			'charge'         => $list( isset( $raw['charge'] ) ? $raw['charge'] : null ),
			'refuse'         => array(
				'crawlers' => $crawlers,
				'agents'   => isset( $refuse['agents'] ) && true === $refuse['agents'],
			),
			'agentReadsFree' => isset( $raw['agentReadsFree'] ) && true === $raw['agentReadsFree'],
		);
	}

	/**
	 * The access decision the dashboard's rules make, in the gate's own order, before any price is
	 * asked for. Pure: the enforcer calls it with the request's signals, and the control plane's
	 * parity test calls it with the same inputs it gives the gate's `decide()`.
	 *
	 *   1. a blocked crawler            → blocked  (before classification: no payment buys past it)
	 *   2. classify, with the dashboard's allow and charge lists joined to the local ones
	 *   3. a use the terms refuse        → blocked  (before the free read: no allowlist undoes it)
	 *   4. a person                      → free
	 *   5. agent reads free by the terms → free
	 *   6. otherwise                     → continue to the catalogue and the price
	 *
	 * @param array      $signals      Naulon_Agent signals for this request.
	 * @param array|null $rules        Normalized rules, or null when none could be read.
	 * @param array      $local_policy The plugin's own seo_allowlist and charge_list.
	 * @return array {action: blocked|free|continue, reason: string, verdict: array|null}
	 */
	public static function access( array $signals, $rules, array $local_policy ) {
		$ua = isset( $signals['user_agent'] ) ? (string) $signals['user_agent'] : '';
		if ( is_array( $rules ) ) {
			$fragment = self::blocked_by( $ua, $rules );
			if ( null !== $fragment ) {
				return array(
					'action'  => 'blocked',
					'reason'  => sprintf( 'crawler blocked by publisher ("%s")', $fragment ),
					'verdict' => null,
				);
			}
		}
		$policy = array(
			'seo_allowlist' => isset( $local_policy['seo_allowlist'] ) && is_array( $local_policy['seo_allowlist'] ) ? $local_policy['seo_allowlist'] : array(),
			'charge_list'   => isset( $local_policy['charge_list'] ) && is_array( $local_policy['charge_list'] ) ? $local_policy['charge_list'] : array(),
		);
		if ( is_array( $rules ) ) {
			$policy['seo_allowlist'] = array_values( array_unique( array_merge( $policy['seo_allowlist'], $rules['allow'] ) ) );
			$policy['charge_list']   = array_values( array_unique( array_merge( $policy['charge_list'], $rules['charge'] ) ) );
		}
		$verdict = Naulon_Agent::classify( $signals, $policy );
		if ( is_array( $rules ) ) {
			$refused = self::refusal( $ua, $verdict['kind'], $rules );
			if ( null !== $refused ) {
				return array(
					'action'  => 'blocked',
					'reason'  => $refused,
					'verdict' => $verdict,
				);
			}
		}
		if ( 'human' === $verdict['kind'] ) {
			return array(
				'action'  => 'free',
				'reason'  => 'human (' . $verdict['reason'] . ')',
				'verdict' => $verdict,
			);
		}
		if ( is_array( $rules ) && $rules['agentReadsFree'] ) {
			return array(
				'action'  => 'free',
				'reason'  => "agent (ai-input free by the site's terms)",
				'verdict' => $verdict,
			);
		}
		return array(
			'action'  => 'continue',
			'reason'  => $verdict['reason'],
			'verdict' => $verdict,
		);
	}

	/**
	 * The block fragment this user agent matches, or null. Checked before classification, so a
	 * payment can never buy past a block.
	 *
	 * @param string $ua    Raw user agent.
	 * @param array  $rules Normalized rules.
	 * @return string|null
	 */
	public static function blocked_by( $ua, array $rules ) {
		$ua = strtolower( (string) $ua );
		foreach ( $rules['block'] as $fragment ) {
			if ( false !== strpos( $ua, $fragment ) ) {
				return $fragment;
			}
		}
		return null;
	}

	/**
	 * Why the publisher's stated terms refuse this request, or null to carry on.
	 *
	 * A person is never refused: the caller runs this only after deciding the request is not a
	 * browser, or for a recognised crawler the allowlist turned into a "person".
	 *
	 * @param string $ua         Raw user agent.
	 * @param string $kind       The classifier's verdict: human|agent.
	 * @param array  $rules      Normalized rules.
	 * @return string|null
	 */
	public static function refusal( $ua, $kind, array $rules ) {
		$ua = strtolower( (string) $ua );
		foreach ( $rules['refuse']['crawlers'] as $row ) {
			if ( false !== strpos( $ua, $row[0] ) ) {
				// First registry hit decides, refused or not: the gate recognises a crawler the same way.
				if ( $row[1] ) {
					return sprintf( '%s is refused by this site\'s terms', $row[0] );
				}
				break;
			}
		}
		if ( 'agent' === $kind && $rules['refuse']['agents'] ) {
			return 'this site refuses AI reading, so agent reads are not for sale';
		}
		return null;
	}
}
