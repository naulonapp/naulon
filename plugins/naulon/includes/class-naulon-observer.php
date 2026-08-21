<?php
/**
 * The audit leg — reporting what this site decided, to the site's own Audit page.
 *
 * A site enforcing in its own runtime is the ONLY witness to most of its own traffic. The
 * agent's request reaches WordPress and nothing else: the fleet gate never sees it, so
 * without this the publisher's Audit and Readiness screens can only show decisions someone
 * else made — which is to say, none. Measured on a live publisher on 2026-08-22: three real
 * GPTBot 402s produced zero rows, and two setup screens told a working site that nothing was
 * priced.
 *
 * **Only machine decisions are reported, because only machine decisions are seen here.** The
 * one call site is Naulon_Enforcer::logged(), which the enforcer reaches only after a human
 * verdict has already returned. That is the same privacy position Naulon_Log states — a
 * reader is not sampled, counted or hashed — and it has a second consequence worth naming:
 * **no reader ever waits on this**. The latency below is paid by crawlers, on their own
 * request, or by nobody.
 *
 * **The money verdicts are not ours to report.** `paid` and `payment-failed` are written by
 * the hosted `/verify` from the settle outcome, and `/_naulon/observe` refuses them with a
 * 400 that says so. A `settled` decision therefore reports NOTHING from here — reporting it
 * would be this site claiming money moved, which is exactly the claim a control plane must
 * never take from a client.
 *
 * ## Why it sends blocking, on `shutdown`
 *
 * The JS half (`packages/enforce/src/enforce/observation-sink.ts`) fires and forgets because
 * its home is a serverless runtime that freezes on response. WordPress has the opposite
 * problem and needs the opposite answer:
 *
 * - `fastcgi_finish_request()` — the clean "answer now, work after" primitive — **does not
 *   exist under mod_php**, which is what the stock `wordpress:php8.3-apache` image runs. A
 *   plugin shipped to arbitrary hosting cannot depend on it.
 * - `wp_remote_post( ..., array( 'blocking' => false ) )` looks like the WordPress idiom, and
 *   it is — for a LOOPBACK call. Against a remote HTTPS endpoint the sub-second timeout it
 *   needs can expire during the TLS handshake, so the request is sometimes never sent and
 *   never reported as unsent. "The audit page is quietly incomplete" is the one failure this
 *   class exists to end; a transport that produces it silently is worse than a chatty one.
 *
 * So the send is blocking, registered on `shutdown` so it runs after the response body has
 * been produced, and it is only ever registered on a request that already recorded a machine
 * decision. A crawler waits up to Naulon_Client::TIMEOUT_REQUEST for it. A reader waits zero.
 *
 * ## Why a failed batch is kept
 *
 * The JS sink swallows every error and does not retry, which is right when the alternative is
 * an unbounded queue in a runtime that may vanish. Here the process is warm and the storage is
 * already there, so a failed batch goes back into one bounded option and rides the next machine
 * request — or the hourly heartbeat, so a site with a trickle of crawler traffic still reports.
 * The buffer is capped at the endpoint's own batch limit and drops OLDEST first: the recent
 * decisions are the ones a publisher is looking at.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Observer {

	/** Reports that have not been accepted yet. Bounded; see the class docblock. */
	const OPTION_PENDING = 'naulon_observe_pending';

	/** Last send outcome, for the Diagnostics screen: {at, ok, sent, error}. */
	const OPTION_STATUS = 'naulon_observe_status';

	/** The endpoint's own cap (`MAX_BATCH` in src/enforce-observe.ts). One call may not carry more. */
	const MAX_BATCH = 50;

	/** Longest user-agent fragment reported. Matches Naulon_Log::MAX_UA — enough to identify the
	 *  crawler, not a fingerprint. */
	const MAX_UA = 120;

	/** @var Naulon_Observer|null */
	private static $instance = null;

	/** @var array Reports recorded during this request. */
	private $queue = array();

	/** @var bool Has the shutdown flush been registered for this request? */
	private $hooked = false;

	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * What a plugin decision is called on the wire.
	 *
	 * `settled` is absent deliberately and `blocked` is unreachable: the enforcer has no
	 * outright-refusal path — an agent that will not pay gets the price again, never a door
	 * slammed — so nothing here can honestly report it.
	 *
	 * @param string $action free|pay|reread|settled.
	 * @return string|null The verdict, or null when there is nothing for us to report.
	 */
	public static function verdict_for( $action ) {
		switch ( (string) $action ) {
			case 'free':
				return 'served-free';
			case 'pay':
				return 'denied';
			case 'reread':
				return 'agent-reread';
			default:
				// 'settled' — /verify wrote `paid` from the settle outcome. Reporting it here
				// would be a second, unbacked claim about money.
				return null;
		}
	}

	/**
	 * Total price of a built 402, in integer micro-USDC.
	 *
	 * Copied from the legs the control plane priced, never recomputed — the same rule the
	 * ledger follows. A leg whose amount does not read as a non-negative integer is skipped
	 * rather than counted as zero.
	 *
	 * @param array $legs Settlement legs.
	 * @return int
	 */
	public static function legs_total( array $legs ) {
		$total = 0;
		foreach ( $legs as $leg ) {
			$requirements = isset( $leg['requirements'] ) && is_array( $leg['requirements'] ) ? $leg['requirements'] : array();
			$amount       = Naulon_Ledger::atomic_or_null( isset( $requirements['amount'] ) ? $requirements['amount'] : null );
			if ( null !== $amount ) {
				$total += $amount;
			}
		}
		return $total;
	}

	/**
	 * Record one decision for reporting, and make sure it gets sent before the request ends.
	 *
	 * @param array  $report {
	 *     @type string $resource     Absolute URL the decision was made for.
	 *     @type string $slug         Canonical slug ('' for a gated non-article path).
	 *     @type string $action       The enforcer's action.
	 *     @type string $kind         read|citation.
	 *     @type string $ua           User agent of the machine that asked.
	 *     @type string $reason       Why, as the classifier put it.
	 *     @type int    $price_micro  What it would have paid, integer micro-USDC.
	 * }
	 * @return void
	 */
	public function record( array $report ) {
		$verdict = self::verdict_for( isset( $report['action'] ) ? $report['action'] : '' );
		if ( null === $verdict ) {
			return;
		}
		$resource = isset( $report['resource'] ) ? (string) $report['resource'] : '';
		if ( '' === $resource ) {
			return;
		}

		$shaped = array(
			'resource' => $resource,
			'slug'     => isset( $report['slug'] ) ? (string) $report['slug'] : '',
			'verdict'  => $verdict,
			// Every path that reaches here is past the human check in compute_decision. There
			// is no branch on which this is 'human', and hard-coding it says so.
			'classifiedAs' => 'agent',
			'kind'     => isset( $report['kind'] ) && 'citation' === $report['kind'] ? 'citation' : 'read',
			'at'       => (int) round( microtime( true ) * 1000 ),
		);

		$price = isset( $report['price_micro'] ) ? (int) $report['price_micro'] : 0;
		if ( $price > 0 ) {
			$shaped['priceMicro'] = $price;
		}

		$ua     = isset( $report['ua'] ) ? substr( (string) $report['ua'], 0, self::MAX_UA ) : '';
		$reason = isset( $report['reason'] ) ? (string) $report['reason'] : '';
		if ( '' !== $ua || '' !== $reason ) {
			$agent = array();
			if ( '' !== $ua ) {
				$agent['ua'] = $ua;
			}
			if ( '' !== $reason ) {
				$agent['classifyReason'] = $reason;
			}
			// `verified`, `verifiedAgent` and `sigInvalid` are deliberately absent: this plugin
			// does not verify Web Bot Auth signatures (see Naulon_Agent), so it has no verdict
			// on them and must not send one. An omitted field is unknown; `false` is a claim.
			$shaped['agent'] = $agent;
		}

		$this->queue[] = $shaped;

		if ( ! $this->hooked ) {
			$this->hooked = true;
			// Late priority: after anything else this request wants to do on shutdown.
			add_action( 'shutdown', array( $this, 'flush' ), 100 );
		}
	}

	/**
	 * Send everything outstanding — this request's decisions plus anything a previous send
	 * could not deliver.
	 *
	 * Never throws and never warns: a reporting failure must not surface to whoever is on the
	 * other end of the request.
	 *
	 * @return void
	 */
	public function flush() {
		$batch       = array_merge( self::pending(), $this->queue );
		$this->queue = array();
		if ( empty( $batch ) ) {
			return;
		}

		// Oldest first out of the buffer, newest kept: a publisher reads the recent end.
		if ( count( $batch ) > self::MAX_BATCH ) {
			$batch = array_slice( $batch, -self::MAX_BATCH );
		}

		if ( ! self::can_report() ) {
			// Not connected yet. Hold what we have rather than dropping it — a site that
			// finishes setup an hour from now should still see the crawls it took meanwhile.
			self::store_pending( $batch );
			return;
		}

		$response = Naulon_Client::instance()->observe( $batch );

		if ( $response['ok'] ) {
			self::store_pending( array() );
			update_option(
				self::OPTION_STATUS,
				array(
					'at'    => time(),
					'ok'    => true,
					'sent'  => count( $batch ),
					'error' => '',
				),
				false
			);
			return;
		}

		// A 400 means the control plane will never accept these bytes — retrying forever would
		// pin a permanently poisoned batch in front of every later report. Drop it, loudly
		// enough that Diagnostics can say so. Anything else (timeout, 5xx, 401 during a key
		// rotation) is worth another try.
		$permanent = 400 === $response['status'] || 403 === $response['status'];
		self::store_pending( $permanent ? array() : $batch );

		update_option(
			self::OPTION_STATUS,
			array(
				'at'    => time(),
				'ok'    => false,
				'sent'  => 0,
				'error' => '' !== $response['error'] ? $response['error'] : sprintf( 'HTTP %d', $response['status'] ),
			),
			false
		);
	}

	/**
	 * Is there anything worth reporting to, right now?
	 *
	 * @return bool
	 */
	public static function can_report() {
		return Naulon_Settings::is_connected() && '' !== Naulon_Settings::api_key();
	}

	/**
	 * Reports still waiting to be accepted.
	 *
	 * @return array
	 */
	public static function pending() {
		$stored = get_option( self::OPTION_PENDING, array() );
		return is_array( $stored ) ? array_values( $stored ) : array();
	}

	/**
	 * Replace the pending buffer.
	 *
	 * @param array $reports Reports to keep.
	 * @return void
	 */
	private static function store_pending( array $reports ) {
		if ( empty( $reports ) ) {
			delete_option( self::OPTION_PENDING );
			return;
		}
		update_option( self::OPTION_PENDING, array_values( $reports ), false );
	}

	/**
	 * Last send outcome, for the Diagnostics screen.
	 *
	 * @return array {at:int, ok:bool, sent:int, error:string}
	 */
	public static function status() {
		$stored = get_option( self::OPTION_STATUS, array() );
		if ( ! is_array( $stored ) ) {
			$stored = array();
		}
		return array(
			'at'    => isset( $stored['at'] ) ? (int) $stored['at'] : 0,
			'ok'    => ! empty( $stored['ok'] ),
			'sent'  => isset( $stored['sent'] ) ? (int) $stored['sent'] : 0,
			'error' => isset( $stored['error'] ) ? (string) $stored['error'] : '',
		);
	}

	/**
	 * Drop everything this class stores.
	 *
	 * Called from the uninstall purge, beside Naulon_Log::clear(): the pending buffer holds the
	 * same kind of record the local decision window does — machine user agents and slugs — so it
	 * goes out with it rather than outliving the plugin in the options table.
	 *
	 * @return void
	 */
	public static function clear() {
		delete_option( self::OPTION_PENDING );
		delete_option( self::OPTION_STATUS );
	}

	/**
	 * Test seam: forget this request's queue and its shutdown registration.
	 *
	 * @return void
	 */
	public function reset() {
		$this->queue  = array();
		$this->hooked = false;
	}
}
