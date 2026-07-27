<?php
/**
 * The decision log — what the toll decided, for the last N machine requests.
 *
 * This exists because "is it working?" is the question every publisher asks first, and the only
 * honest answer is a list of real decisions rather than a green tick.
 *
 * **Human requests are never recorded.** Not sampled, not counted, not hashed — not touched. That
 * is a privacy position and a performance one at the same time: a WordPress site's traffic is
 * overwhelmingly human, and writing a row per page view would be both a surveillance log we have
 * no business keeping and a database write on the hot path. Machines are the only party this
 * plugin has any business logging, and they are rare enough that a bounded ring buffer in one
 * option is the right storage.
 *
 * The buffer is capped and lossy under concurrency by design: two agent requests landing in the
 * same instant can lose one entry to the read-modify-write. That is acceptable for a diagnostic
 * of "the last few decisions" and is NOT acceptable for money — which is why settlements go to
 * their own table with a unique key (see Naulon_Ledger), and this file never records an amount.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Log {

	const OPTION = 'naulon_decisions';

	/** How many decisions are kept. Small on purpose: this is a window, not an archive. */
	const MAX_ENTRIES = 50;

	/** Longest user-agent fragment stored. Enough to identify the crawler, not a fingerprint. */
	const MAX_UA = 120;

	/**
	 * Append a decision.
	 *
	 * @param array $entry {
	 *     @type string $action free|pay|settled|reread.
	 *     @type string $reason Why, in words.
	 *     @type string $slug   Canonical slug.
	 *     @type string $ua     User agent of the machine that asked.
	 *     @type string $kind   read|citation.
	 * }
	 * @return void
	 */
	public static function record( array $entry ) {
		$entries   = self::all();
		$entries[] = array(
			'at'     => time(),
			'action' => isset( $entry['action'] ) ? (string) $entry['action'] : '',
			'reason' => isset( $entry['reason'] ) ? (string) $entry['reason'] : '',
			'slug'   => isset( $entry['slug'] ) ? (string) $entry['slug'] : '',
			'kind'   => isset( $entry['kind'] ) ? (string) $entry['kind'] : 'read',
			'ua'     => isset( $entry['ua'] ) ? substr( (string) $entry['ua'], 0, self::MAX_UA ) : '',
		);

		if ( count( $entries ) > self::MAX_ENTRIES ) {
			$entries = array_slice( $entries, -self::MAX_ENTRIES );
		}

		// Autoload off: this is read on one admin screen and nowhere else.
		update_option( self::OPTION, $entries, 'no' );
	}

	/**
	 * Every recorded decision, oldest first.
	 *
	 * @return array[]
	 */
	public static function all() {
		$stored = get_option( self::OPTION, array() );
		return is_array( $stored ) ? array_values( $stored ) : array();
	}

	/**
	 * Newest first, capped.
	 *
	 * @param int $limit Max entries.
	 * @return array[]
	 */
	public static function recent( $limit = self::MAX_ENTRIES ) {
		$entries = array_reverse( self::all() );
		return array_slice( $entries, 0, max( 1, (int) $limit ) );
	}

	/**
	 * How many of each action are in the window. The one number a publisher reads first: "did
	 * anything get charged?"
	 *
	 * @return array<string, int>
	 */
	public static function counts() {
		$counts = array(
			'free'    => 0,
			'pay'     => 0,
			'settled' => 0,
			'reread'  => 0,
		);
		foreach ( self::all() as $entry ) {
			$action = isset( $entry['action'] ) ? (string) $entry['action'] : '';
			if ( isset( $counts[ $action ] ) ) {
				++$counts[ $action ];
			}
		}
		return $counts;
	}

	/**
	 * Empty the window.
	 *
	 * @return void
	 */
	public static function clear() {
		delete_option( self::OPTION );
	}
}
