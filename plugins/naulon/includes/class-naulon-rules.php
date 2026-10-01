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

	/** Transient holding the fresh fleet-agent host, cached alongside the rules it travels with
	 *  on the same `/_naulon/enforce-config` document. */
	const FLEET_TRANSIENT = 'naulon_fleet_agent';

	/** Option holding the last good fleet-agent host, served when a refresh fails. */
	const FLEET_LAST_GOOD = 'naulon_fleet_agent_last_good';

	/** A bare host only. Anything that is not one would point Naulon_Fleet_Pull's directory
	 *  fetch somewhere the control plane never named, so a malformed value is treated as absent
	 *  rather than trusted. Mirrors FLEET_AGENT_HOST in @naulon/enforce's config-source.ts. */
	const FLEET_AGENT_HOST = '/^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/';

	/** Transient holding the fresh fleet-publisher tenant id, cached alongside the rules and the
	 *  fleet agent — same document, same request. */
	const FLEET_PUBLISHER_TRANSIENT = 'naulon_fleet_publisher';

	/** Option holding the last good fleet-publisher tenant id. */
	const FLEET_PUBLISHER_LAST_GOOD = 'naulon_fleet_publisher_last_good';

	/** A tenant id, never a host — case-sensitive and NOT lowercased anywhere below. Mirrors
	 *  FLEET_PUBLISHER_ID in @naulon/enforce's config-source.ts. */
	const FLEET_PUBLISHER_ID = '/^[A-Za-z0-9._:-]{1,128}$/';

	/** The operator ids this site is armed for (`identity.armed`), cached beside the rules. */
	const ARMED_TRANSIENT = 'naulon_identity_armed';
	const ARMED_LAST_GOOD = 'naulon_identity_armed_last_good';

	/**
	 * How long an armed set stays trusted without a successful refresh. The hourly cron renews it
	 * well inside this, and it sits far under the spec's 72-hour disarm bound: an armed set nobody
	 * could refresh is missing evidence, and missing evidence never charges.
	 */
	const ARMED_MAX_AGE = 21600;

	/** An operator id as CRAWLER_PROOF spells one. */
	const OPERATOR_ID = '/^[a-z0-9-]{1,64}$/';

	/** @var Naulon_Rules|null */
	private static $instance = null;

	/** @var array|null|false Memo for this request: false = not loaded yet. */
	private $memo = false;

	/** @var string|false Memo for this request: false = not loaded yet. */
	private $fleet_memo = false;

	/** @var string|false Memo for this request: false = not loaded yet. */
	private $fleet_publisher_memo = false;

	/** @var array|false Armed operator ids for this request; false until first read. */
	private $armed_memo = false;

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

			// Same document, same request: the fleet agent travels with the rules it is cached
			// alongside, so this never costs a second round trip. Absent or malformed clears the
			// cached agent too — an editor removing the field must turn the rule off, not leave a
			// stale host trusted forever.
			$enforcement = isset( $response['body']['enforcement'] ) && is_array( $response['body']['enforcement'] )
				? $response['body']['enforcement']
				: array();
			$fleet_agent = self::valid_fleet_agent( isset( $enforcement['fleetAgent'] ) ? $enforcement['fleetAgent'] : null );
			set_transient( self::FLEET_TRANSIENT, $fleet_agent, self::TTL );
			update_option( self::FLEET_LAST_GOOD, $fleet_agent, false );
			$this->fleet_memo = $fleet_agent;

			// The tenant id this site was configured with, cached the same way and for the same
			// reason: the gate signs a pull for every tenant it hosts, so the agent host alone
			// never proves the pull was decided for THIS site.
			$fleet_publisher = self::valid_fleet_publisher( isset( $enforcement['fleetPublisher'] ) ? $enforcement['fleetPublisher'] : null );
			set_transient( self::FLEET_PUBLISHER_TRANSIENT, $fleet_publisher, self::TTL );
			update_option( self::FLEET_PUBLISHER_LAST_GOOD, $fleet_publisher, false );
			$this->fleet_publisher_memo = $fleet_publisher;

			// The operators this site is armed for. Same document, same caching, and the same
			// rule: absent or malformed clears it, which returns every claim to observing.
			$armed = self::valid_armed( isset( $response['body']['identity'] ) && is_array( $response['body']['identity'] ) && isset( $response['body']['identity']['armed'] ) ? $response['body']['identity']['armed'] : null );
			set_transient( self::ARMED_TRANSIENT, $armed, self::TTL );
			update_option(
				self::ARMED_LAST_GOOD,
				array(
					'ids'       => $armed,
					'stored_at' => time(),
				),
				false
			);
			$this->armed_memo = $armed;

			return $this->memo;
		}
		// Stale beats nothing: a publisher who blocked a crawler yesterday still blocks it while
		// the control plane is unreachable. Retry sooner than a fresh copy would expire.
		$last = get_option( self::LAST_GOOD );
		if ( is_array( $last ) ) {
			set_transient( self::TRANSIENT, $last, 60 );
			$this->memo = self::normalize( $last );

			$fleet_last = get_option( self::FLEET_LAST_GOOD );
			$fleet_last = is_string( $fleet_last ) ? $fleet_last : '';
			set_transient( self::FLEET_TRANSIENT, $fleet_last, 60 );
			$this->fleet_memo = $fleet_last;

			$fleet_publisher_last = get_option( self::FLEET_PUBLISHER_LAST_GOOD );
			$fleet_publisher_last = is_string( $fleet_publisher_last ) ? $fleet_publisher_last : '';
			set_transient( self::FLEET_PUBLISHER_TRANSIENT, $fleet_publisher_last, 60 );
			$this->fleet_publisher_memo = $fleet_publisher_last;

			// The last good armed set, aged as it stands: a failed refresh never renews it.
			$this->armed_memo = self::armed_from( get_option( self::ARMED_LAST_GOOD ), time() );

			return $this->memo;
		}
		$this->memo = null;
		return null;
	}

	/**
	 * The fleet's own signing identity for this site, or '' when none is configured. Cache-only:
	 * unlike rules, this is read from the pre-classification fleet-pull check in
	 * Naulon_Enforcer, before it is known whether the request looks human — so it must never
	 * force a network fetch of its own. It relies on refresh() above (a machine request or the
	 * cron) to keep the cached copy warm.
	 *
	 * @return string
	 */
	public function fleet_agent() {
		if ( false !== $this->fleet_memo ) {
			return $this->fleet_memo;
		}
		$cached = get_transient( self::FLEET_TRANSIENT );
		if ( is_string( $cached ) ) {
			$this->fleet_memo = $cached;
			return $this->fleet_memo;
		}
		$last             = get_option( self::FLEET_LAST_GOOD );
		$this->fleet_memo = is_string( $last ) ? $last : '';
		return $this->fleet_memo;
	}

	/**
	 * This site's own tenant id on the fleet, or '' when none is configured. Cache-only, for the
	 * same reason as fleet_agent(): read before classification, it must never force a fetch.
	 *
	 * @return string
	 */
	public function fleet_publisher() {
		if ( false !== $this->fleet_publisher_memo ) {
			return $this->fleet_publisher_memo;
		}
		$cached = get_transient( self::FLEET_PUBLISHER_TRANSIENT );
		if ( is_string( $cached ) ) {
			$this->fleet_publisher_memo = $cached;
			return $this->fleet_publisher_memo;
		}
		$last                       = get_option( self::FLEET_PUBLISHER_LAST_GOOD );
		$this->fleet_publisher_memo = is_string( $last ) ? $last : '';
		return $this->fleet_publisher_memo;
	}

	/**
	 * The crawler operators this site is armed for. Cache-only, like fleet_agent(): read on a
	 * request the classifier may call a person, so it must never force a fetch.
	 *
	 * `naulon_identity_armed` is a test seam for a local gate that serves no enforce-config. No
	 * real install sets it.
	 *
	 * @return string[]
	 */
	public function armed() {
		if ( false === $this->armed_memo ) {
			$cached = get_transient( self::ARMED_TRANSIENT );
			if ( is_array( $cached ) ) {
				$this->armed_memo = $cached;
			} else {
				$this->armed_memo = self::armed_from( get_option( self::ARMED_LAST_GOOD ), time() );
			}
		}
		return self::valid_armed( apply_filters( 'naulon_identity_armed', $this->armed_memo ) );
	}

	/**
	 * The stored armed set, or empty once it is older than ARMED_MAX_AGE or has no age at all.
	 *
	 * @param mixed $stored The ARMED_LAST_GOOD option value.
	 * @param int   $now    Unix seconds.
	 * @return string[]
	 */
	public static function armed_from( $stored, $now ) {
		if ( ! is_array( $stored ) || ! isset( $stored['ids'], $stored['stored_at'] ) ) {
			return array();
		}
		if ( $now - (int) $stored['stored_at'] > self::ARMED_MAX_AGE ) {
			return array();
		}
		return self::valid_armed( $stored['ids'] );
	}

	/**
	 * @param mixed $raw The `identity.armed` field as the control plane sent it.
	 * @return string[] Operator ids, or empty when absent or malformed.
	 */
	public static function valid_armed( $raw ) {
		if ( ! is_array( $raw ) ) {
			return array();
		}
		$out = array();
		foreach ( $raw as $id ) {
			if ( is_string( $id ) && 1 === preg_match( self::OPERATOR_ID, $id ) ) {
				$out[] = $id;
			}
		}
		return array_values( array_unique( $out ) );
	}

	/**
	 * @param mixed $raw The `enforcement.fleetPublisher` field as the control plane sent it.
	 * @return string The tenant id, unchanged, or '' when absent or malformed.
	 */
	private static function valid_fleet_publisher( $raw ) {
		return is_string( $raw ) && 1 === preg_match( self::FLEET_PUBLISHER_ID, $raw ) ? $raw : '';
	}

	/**
	 * @param mixed $raw The `enforcement.fleetAgent` field as the control plane sent it.
	 * @return string The bare host, lowercased, or '' when absent or malformed.
	 */
	private static function valid_fleet_agent( $raw ) {
		return is_string( $raw ) && 1 === preg_match( self::FLEET_AGENT_HOST, $raw ) ? strtolower( $raw ) : '';
	}

	/** Forget the cached copy, so the next read asks the control plane. */
	public static function flush() {
		delete_transient( self::TRANSIENT );
		delete_transient( self::FLEET_TRANSIENT );
		delete_transient( self::FLEET_PUBLISHER_TRANSIENT );
		delete_transient( self::ARMED_TRANSIENT );
		self::instance()->armed_memo           = false;
		self::instance()->memo                 = false;
		self::instance()->fleet_memo           = false;
		self::instance()->fleet_publisher_memo = false;
	}

	/** Test seam: forget this request's memo, and every stored copy. */
	public function reset() {
		$this->memo                 = false;
		$this->fleet_memo           = false;
		$this->fleet_publisher_memo = false;
		$this->armed_memo           = false;
		delete_transient( self::TRANSIENT );
		delete_transient( self::ARMED_TRANSIENT );
		delete_option( self::ARMED_LAST_GOOD );
		delete_transient( self::FLEET_TRANSIENT );
		delete_transient( self::FLEET_PUBLISHER_TRANSIENT );
		delete_option( self::LAST_GOOD );
		delete_option( self::FLEET_LAST_GOOD );
		delete_option( self::FLEET_PUBLISHER_LAST_GOOD );
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
			// What an armed, forged crawler claim gets: charged like any agent, or refused.
			'forged'         => isset( $raw['forged'] ) && 'block' === $raw['forged'] ? 'block' : 'charge',
			// `off` switches the identity check out entirely for this site.
			'identityMode'   => isset( $raw['identityMode'] ) && 'off' === $raw['identityMode'] ? 'off' : 'auto',
		);
	}

	/**
	 * The access decision the dashboard's rules make, in the gate's own order, before any price is
	 * asked for. Pure: the enforcer calls it with the request's signals, and the control plane's
	 * parity test calls it with the same inputs it gives the gate's `decide()`.
	 *
	 *   1. a blocked crawler            → blocked  (before classification: no payment buys past it)
	 *   2. classify, with the dashboard's allow and charge lists joined to the local ones, and the
	 *      crawler identity check applied (Naulon_Identity::classify)
	 *   2b. an armed, forged claim on a site set to `forged: block` → blocked
	 *   3. a use the terms refuse        → blocked  (before the free read: no allowlist undoes it)
	 *   4. a person                      → free
	 *   5. agent reads free by the terms → free
	 *   6. otherwise                     → continue to the catalogue and the price
	 *
	 * @param array      $signals      Naulon_Agent signals for this request.
	 * @param array|null $rules        Normalized rules, or null when none could be read.
	 * @param array      $local_policy The plugin's own seo_allowlist and charge_list.
	 * @param array|null $identity     {compiled, client_ip, now, armed}, or null to skip the check.
	 * @return array {action: blocked|free|continue, reason: string, verdict: array|null, identity: array|null, forged_claim: array|null}
	 */
	public static function access( array $signals, $rules, array $local_policy, $identity = null ) {
		$ua = isset( $signals['user_agent'] ) ? (string) $signals['user_agent'] : '';
		if ( is_array( $rules ) ) {
			$fragment = self::blocked_by( $ua, $rules );
			if ( null !== $fragment ) {
				return array(
					'action'       => 'blocked',
					'reason'       => sprintf( 'crawler blocked by publisher (%s)', $fragment ),
					'verdict'      => null,
					'identity'     => null,
					'forged_claim' => null,
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
		if ( is_array( $identity ) ) {
			$mode   = is_array( $rules ) ? $rules['identityMode'] : 'auto';
			$result = Naulon_Identity::classify(
				$signals,
				$policy,
				$mode,
				isset( $identity['compiled'] ) ? $identity['compiled'] : null,
				isset( $identity['client_ip'] ) ? $identity['client_ip'] : null,
				isset( $identity['now'] ) ? (int) $identity['now'] : time(),
				isset( $identity['armed'] ) && is_array( $identity['armed'] ) ? $identity['armed'] : array()
			);
		} else {
			$result = array(
				'verdict'      => Naulon_Agent::classify( $signals, $policy ),
				'identity'     => null,
				'forged_claim' => null,
			);
		}
		$verdict = $result['verdict'];
		$out     = static function ( $action, $reason ) use ( $verdict, $result ) {
			return array(
				'action'       => $action,
				'reason'       => $reason,
				'verdict'      => $verdict,
				'identity'     => $result['identity'],
				'forged_claim' => $result['forged_claim'],
			);
		};
		$forged = isset( $verdict['identity'] ) && 'forged' === $verdict['identity'] && null !== $result['forged_claim'];
		if ( $forged && is_array( $rules ) && 'block' === $rules['forged'] ) {
			return $out( 'blocked', $verdict['reason'] );
		}
		if ( is_array( $rules ) ) {
			$refused = self::refusal( $ua, $verdict['kind'], $rules );
			if ( null !== $refused ) {
				return $out( 'blocked', $refused );
			}
		}
		if ( 'human' === $verdict['kind'] ) {
			return $out( 'free', 'human (' . $verdict['reason'] . ')' );
		}
		if ( is_array( $rules ) && $rules['agentReadsFree'] ) {
			return $out( 'free', "agent (ai-input free by the site's terms)" );
		}
		return $out( 'continue', $verdict['reason'] );
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
