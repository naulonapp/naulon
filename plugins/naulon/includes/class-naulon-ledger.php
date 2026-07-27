<?php
/**
 * The earnings ledger — what this site was actually paid, one row per settlement leg.
 *
 * In in-app mode WordPress is the party that settles, so WordPress is the only place that sees
 * every settlement for this site. That makes a local ledger the honest source for the earnings
 * screen rather than a second copy of something the control plane holds.
 *
 * Two rules govern everything here, and both come from the same place: this table is a record of
 * money.
 *
 * 1. **Nothing is computed. Everything is copied.** The amounts stored are the atomic-USDC
 *    integers the control plane put in the 402 the buyer signed against — the exact figures the
 *    settle re-derived and checked. This class does not price, split, convert or round anything.
 *    A second implementation of "how much does this author get" would not fail loudly when it
 *    drifted; it would quietly disagree with what was paid.
 *
 * 2. **Integer micro-USDC end to end, never a float.** Amounts arrive as decimal strings, are
 *    validated as digits, stored as BIGINT, summed by the database, and formatted for display by
 *    integer division. `floatval()` appears nowhere in this file, deliberately.
 *
 * One row per leg (not per settlement) because that is the shape every question has: site total
 * is a SUM, per-author is a GROUP BY on the payee address, and the recent-activity list is a
 * plain ORDER BY. Aggregating a JSON blob in PHP would have been the same data, slower and
 * wrong-shaped.
 *
 * A leg is either settled on-chain now or buyer-authorized and settled later by the drain. Which
 * one is NOT guessed from the leg's position: the 402 itself declares its settlement semantics
 * (`extensions.naulonLegs.settlement`), and an unrecognized declaration stores `unknown` rather
 * than a confident lie.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Ledger {

	/** Schema version. Bump when the table changes; `maybe_install()` re-runs dbDelta. */
	const DB_VERSION = 1;

	const DB_VERSION_OPTION = 'naulon_db_version';

	/** USDC has 6 decimals; an "atomic" unit is one micro-USDC. */
	const MICRO_PER_USDC = 1000000;

	/** The settlement semantics the current protocol declares: leg 0 settles synchronously, the
	 *  rest are buyer-authorized and drained afterwards. */
	const MODE_AUTHOR_SYNC = 'author-sync-rest-deferred';

	/** Leg status values. */
	const STATUS_SETTLED = 'settled';
	const STATUS_PENDING = 'pending';
	const STATUS_UNKNOWN = 'unknown';

	/**
	 * The table name, prefixed for this site (multisite gives each site its own).
	 *
	 * @return string
	 */
	public static function table() {
		global $wpdb;
		return $wpdb->prefix . 'naulon_earnings';
	}

	/**
	 * Create or migrate the table. Safe to call repeatedly; dbDelta is idempotent.
	 *
	 * @return void
	 */
	public static function install() {
		global $wpdb;
		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table   = self::table();
		$collate = $wpdb->get_charset_collate();

		// `settlement_ref` + `leg_index` is unique: a settle retried after a timeout must not be
		// counted twice. Money records are the one place a duplicate is worse than a miss.
		$sql = "CREATE TABLE {$table} (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
			settled_at DATETIME NOT NULL,
			post_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
			slug VARCHAR(191) NOT NULL DEFAULT '',
			kind VARCHAR(16) NOT NULL DEFAULT 'read',
			settlement_ref VARCHAR(191) NOT NULL DEFAULT '',
			leg_index SMALLINT UNSIGNED NOT NULL DEFAULT 0,
			role VARCHAR(32) NOT NULL DEFAULT '',
			pay_to VARCHAR(42) NOT NULL DEFAULT '',
			amount_atomic BIGINT UNSIGNED NOT NULL DEFAULT 0,
			network VARCHAR(64) NOT NULL DEFAULT '',
			payer VARCHAR(42) NOT NULL DEFAULT '',
			status VARCHAR(16) NOT NULL DEFAULT 'settled',
			PRIMARY KEY  (id),
			UNIQUE KEY uniq_leg (settlement_ref, leg_index),
			KEY settled_at (settled_at),
			KEY pay_to (pay_to),
			KEY post_id (post_id)
		) {$collate};";

		dbDelta( $sql );
		update_option( self::DB_VERSION_OPTION, self::DB_VERSION, 'no' );
	}

	/**
	 * Install only when the stored schema version is behind. Called on every admin load, so it
	 * must be a single option read in the common case.
	 *
	 * @return void
	 */
	public static function maybe_install() {
		if ( (int) get_option( self::DB_VERSION_OPTION, 0 ) === self::DB_VERSION ) {
			return;
		}
		self::install();
	}

	/**
	 * Record a settlement. One row per leg.
	 *
	 * @param array $settlement {
	 *     @type int    $post_id        Post that was paid for.
	 *     @type string $slug           Canonical slug.
	 *     @type string $kind           read|citation.
	 *     @type string $settlement_ref The control plane's reference for this settle.
	 *     @type string $payer          Buyer wallet.
	 *     @type array  $legs           The legs from the built 402, in order.
	 *     @type string $mode           Declared settlement semantics from the 402, or ''.
	 * }
	 * @return int Rows written.
	 */
	public static function record( array $settlement ) {
		global $wpdb;

		$legs = isset( $settlement['legs'] ) && is_array( $settlement['legs'] ) ? $settlement['legs'] : array();
		if ( empty( $legs ) ) {
			return 0;
		}

		// A settle without a reference should not happen, but a missing one must not make every
		// such row collide on the unique key and silently drop. Synthesize a local id instead.
		$ref = isset( $settlement['settlement_ref'] ) ? trim( (string) $settlement['settlement_ref'] ) : '';
		if ( '' === $ref ) {
			$ref = 'local-' . wp_generate_uuid4();
		}

		$mode    = isset( $settlement['mode'] ) ? (string) $settlement['mode'] : '';
		$written = 0;

		foreach ( array_values( $legs ) as $index => $leg ) {
			$requirements = isset( $leg['requirements'] ) && is_array( $leg['requirements'] ) ? $leg['requirements'] : array();
			$amount       = self::atomic_or_null( isset( $requirements['amount'] ) ? $requirements['amount'] : null );
			$pay_to       = isset( $requirements['payTo'] ) ? (string) $requirements['payTo'] : '';

			// An amount we cannot read as an integer is not stored as zero — it is not stored at
			// all. A zero in a money table reads as "this author earned nothing", which is a
			// different and worse statement than "we have no record".
			if ( null === $amount || ! Naulon_Wallet::is_valid( $pay_to ) ) {
				continue;
			}

			$role = isset( $leg['role'] ) ? (string) $leg['role'] : '';

			$inserted = $wpdb->query( // phpcs:ignore WordPress.DB.DirectDatabaseQuery -- custom ledger table; no core API covers it.
				$wpdb->prepare(
					// INSERT IGNORE, not insert(): the unique key is the idempotency guarantee for
					// a retried settle, and a duplicate must be a no-op rather than an error.
					'INSERT IGNORE INTO %i
					(settled_at, post_id, slug, kind, settlement_ref, leg_index, role, pay_to, amount_atomic, network, payer, status)
					VALUES (%s, %d, %s, %s, %s, %d, %s, %s, %d, %s, %s, %s)',
					self::table(),
					current_time( 'mysql', true ),
					isset( $settlement['post_id'] ) ? (int) $settlement['post_id'] : 0,
					isset( $settlement['slug'] ) ? (string) $settlement['slug'] : '',
					isset( $settlement['kind'] ) ? (string) $settlement['kind'] : 'read',
					$ref,
					(int) $index,
					$role,
					Naulon_Wallet::normalize( $pay_to ),
					$amount,
					isset( $requirements['network'] ) ? (string) $requirements['network'] : '',
					isset( $settlement['payer'] ) ? strtolower( (string) $settlement['payer'] ) : '',
					self::leg_status( (int) $index, $mode )
				)
			);
			$written += (int) $inserted;
		}

		return $written;
	}

	/**
	 * Has this leg's money moved, or is it authorized and waiting for the drain?
	 *
	 * Read from what the 402 DECLARED, never from the leg's position. Position happens to be the
	 * answer under today's semantics, but a ledger that hard-codes it would keep saying "settled"
	 * after the protocol changed, and would be believed.
	 *
	 * @param int    $index Leg index.
	 * @param string $mode  Declared settlement semantics from the 402.
	 * @return string
	 */
	public static function leg_status( $index, $mode ) {
		if ( self::MODE_AUTHOR_SYNC === $mode ) {
			return 0 === (int) $index ? self::STATUS_SETTLED : self::STATUS_PENDING;
		}
		if ( '' === $mode ) {
			// No extension block at all: a single-author 402, which has exactly one leg and it is
			// the synchronous one. More than one leg with no declaration is not something we can
			// describe honestly.
			return 0 === (int) $index ? self::STATUS_SETTLED : self::STATUS_UNKNOWN;
		}
		return self::STATUS_UNKNOWN;
	}

	/**
	 * The settlement mode a built 402 declares, read out of the header the control plane built.
	 *
	 * @param string $header Base64 PAYMENT-REQUIRED value.
	 * @return string The declared mode, or '' when the 402 carries no leg extension.
	 */
	public static function mode_from_header( $header ) {
		$parsed = self::decode_402( $header );
		if ( null === $parsed ) {
			return '';
		}
		if ( isset( $parsed['extensions']['naulonLegs']['settlement'] ) && is_string( $parsed['extensions']['naulonLegs']['settlement'] ) ) {
			return $parsed['extensions']['naulonLegs']['settlement'];
		}
		return '';
	}

	/**
	 * The 402 challenge as a structure. The header is base64 JSON that the control plane built;
	 * decoding it is how the Test toll screen can show a publisher the actual price, chain and
	 * payee rather than asserting that a toll "works".
	 *
	 * @param string $header Base64 PAYMENT-REQUIRED value.
	 * @return array|null
	 */
	public static function decode_402( $header ) {
		if ( ! is_string( $header ) || '' === $header ) {
			return null;
		}
		$decoded = base64_decode( $header, true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions -- decoding our own protocol header, not obfuscation.
		if ( ! is_string( $decoded ) || '' === $decoded ) {
			return null;
		}
		$parsed = json_decode( $decoded, true );
		return is_array( $parsed ) ? $parsed : null;
	}

	/**
	 * Everything this site has been paid, in atomic USDC.
	 *
	 * @param string $status Filter by leg status, or '' for all.
	 * @return int
	 */
	public static function site_total( $status = self::STATUS_SETTLED ) {
		global $wpdb;
		if ( '' === $status ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL
			return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COALESCE(SUM(amount_atomic), 0) FROM %i', self::table() ) );
		}
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		return (int) $wpdb->get_var(
			$wpdb->prepare( 'SELECT COALESCE(SUM(amount_atomic), 0) FROM %i WHERE status = %s', self::table(), $status )
		);
	}

	/**
	 * Total paid to one wallet.
	 *
	 * @param string $wallet Payee address.
	 * @param string $status Leg status filter, or ''.
	 * @return int Atomic USDC.
	 */
	public static function total_for_wallet( $wallet, $status = self::STATUS_SETTLED ) {
		global $wpdb;
		if ( ! Naulon_Wallet::is_valid( $wallet ) ) {
			return 0;
		}
		$normalized = Naulon_Wallet::normalize( $wallet );
		if ( '' === $status ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			return (int) $wpdb->get_var(
				$wpdb->prepare( 'SELECT COALESCE(SUM(amount_atomic), 0) FROM %i WHERE pay_to = %s', self::table(), $normalized )
			);
		}
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		return (int) $wpdb->get_var(
			$wpdb->prepare(
				'SELECT COALESCE(SUM(amount_atomic), 0) FROM %i WHERE pay_to = %s AND status = %s',
				self::table(),
				$normalized,
				$status
			)
		);
	}

	/**
	 * Per-payee totals, biggest first.
	 *
	 * @param int $limit Max rows.
	 * @return array[] Each {pay_to, settled, pending}.
	 */
	public static function totals_by_wallet( $limit = 100 ) {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT pay_to,
					COALESCE(SUM(CASE WHEN status = %s THEN amount_atomic ELSE 0 END), 0) AS settled,
					COALESCE(SUM(CASE WHEN status = %s THEN amount_atomic ELSE 0 END), 0) AS pending
				FROM %i
				GROUP BY pay_to
				ORDER BY settled DESC
				LIMIT %d',
				self::STATUS_SETTLED,
				self::STATUS_PENDING,
				self::table(),
				(int) $limit
			),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * The most recent legs, newest first.
	 *
	 * @param int    $limit  Max rows.
	 * @param string $wallet Restrict to one payee, or '' for all.
	 * @return array[]
	 */
	public static function recent( $limit = 25, $wallet = '' ) {
		global $wpdb;
		$limit = max( 1, min( 200, (int) $limit ) );

		// A wallet was asked for but is not one: return nothing. Falling through to the unscoped
		// query would show an author with a malformed address the whole site's payments.
		if ( '' !== $wallet && ! Naulon_Wallet::is_valid( $wallet ) ) {
			return array();
		}

		if ( '' !== $wallet ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$rows = $wpdb->get_results(
				$wpdb->prepare(
					'SELECT * FROM %i WHERE pay_to = %s ORDER BY settled_at DESC, id DESC LIMIT %d',
					self::table(),
					Naulon_Wallet::normalize( $wallet ),
					$limit
				),
				ARRAY_A
			);
			return is_array( $rows ) ? $rows : array();
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results(
			$wpdb->prepare( 'SELECT * FROM %i ORDER BY settled_at DESC, id DESC LIMIT %d', self::table(), $limit ),
			ARRAY_A
		);
		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * How many distinct settlements are on record.
	 *
	 * @return int
	 */
	public static function settlement_count() {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL
		return (int) $wpdb->get_var( $wpdb->prepare( 'SELECT COUNT(DISTINCT settlement_ref) FROM %i', self::table() ) );
	}

	/**
	 * Atomic USDC as a human-readable amount. Integer arithmetic only — a float here would be a
	 * rounding error in a money column, printed with confidence.
	 *
	 * @param int|string $atomic Atomic (micro) USDC.
	 * @return string e.g. "0.005000".
	 */
	public static function format_usdc( $atomic ) {
		$value = self::atomic_or_null( $atomic );
		if ( null === $value ) {
			return '0.000000';
		}
		$whole = intdiv( $value, self::MICRO_PER_USDC );
		$micro = $value % self::MICRO_PER_USDC;
		return number_format_i18n( $whole ) . '.' . str_pad( (string) $micro, 6, '0', STR_PAD_LEFT );
	}

	/**
	 * Parse an atomic amount strictly: a string of digits, or an integer. Anything else — a
	 * decimal, a float, a number in scientific notation, a negative — is refused rather than
	 * coerced. Coercion is how a wrong number gets into a money table.
	 *
	 * @param mixed $value Candidate.
	 * @return int|null
	 */
	public static function atomic_or_null( $value ) {
		if ( is_int( $value ) ) {
			return $value >= 0 ? $value : null;
		}
		if ( is_string( $value ) && 1 === preg_match( '/^[0-9]+$/', $value ) ) {
			return (int) $value;
		}
		return null;
	}

	/**
	 * Drop the table. Uninstall only.
	 *
	 * @return void
	 */
	public static function drop() {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery, WordPress.DB.PreparedSQL
		$wpdb->query( $wpdb->prepare( 'DROP TABLE IF EXISTS %i', self::table() ) );
		delete_option( self::DB_VERSION_OPTION );
	}
}
