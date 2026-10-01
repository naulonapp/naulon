<?php
/**
 * The gate's merged crawler-ranges document (`/.well-known/naulon/crawler-ranges.json`): which
 * addresses each crawler operator publishes, plus the proxies whose addresses are never a
 * caller's own. A port of the read side of packages/shared/src/crawlerRanges.ts.
 *
 * Stored compiled, in a non-autoloaded option: validated and compiled once when fetched, so a
 * crawler request only reads it back. Only a request whose user-agent names a crawler reads it. Refreshed by the hourly cron when older than REFRESH_SECONDS,
 * never on a request path. Every failed or refused fetch keeps the last good copy: losing the
 * ranges must degrade to `unverified`, which never charges anyone.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Ranges {

	const OPTION = 'naulon_crawler_ranges';

	/** An operator whose last good fetch is older than this can verify but cannot accuse. */
	const FRESH_SECONDS = 604800;

	/** How old the stored copy may get before the cron fetches it again. */
	const REFRESH_SECONDS = 21600;

	/** A document larger than this is not the gate's; the real one is ~24 KB. */
	const MAX_BYTES = 2097152;

	const KINDS = array( 'ranges', 'signature', 'none' );

	/** The stored option's shape. A copy in any other shape is ignored and refetched. */
	const STORE_VERSION = 3;

	/** @var Naulon_Ranges|null */
	private static $instance = null;

	/** @var array|null|false Compiled copy for this request; false until first read. */
	private $compiled = false;

	/**
	 * @return Naulon_Ranges
	 */
	public static function instance() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Validate a decoded document. Stricter than the TS parser in one respect: any prefix that
	 * fails Naulon_Ip::parse_cidr's minimums refuses the WHOLE document, so a compromised gate
	 * cannot win partially by slipping one /0 among good rows.
	 *
	 * @param mixed $raw Decoded JSON.
	 * @return array|null The normalised document.
	 */
	public static function validate( $raw ) {
		if ( ! is_array( $raw ) ) {
			return null;
		}
		$encoded = json_encode( $raw ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode -- a size probe, not output.
		if ( false === $encoded || strlen( $encoded ) > self::MAX_BYTES ) {
			return null;
		}
		if ( ! isset( $raw['version'] ) || 1 !== $raw['version'] || ! isset( $raw['generatedAt'] ) || ! is_string( $raw['generatedAt'] ) ) {
			return null;
		}
		if ( ! isset( $raw['operators'] ) || ! is_array( $raw['operators'] ) || ! isset( $raw['proxies'] ) || ! is_array( $raw['proxies'] ) ) {
			return null;
		}
		$proxies = array();
		foreach ( $raw['proxies'] as $name => $list ) {
			// An empty list would read as "this proxy has no addresses", turning its egress into a caller.
			if ( ! self::all_prefixes( $list ) || empty( $list ) ) {
				return null;
			}
			$proxies[ (string) $name ] = array_values( $list );
		}
		$operators = array();
		foreach ( $raw['operators'] as $o ) {
			if ( ! is_array( $o ) ) {
				return null;
			}
			if ( ! isset( $o['id'], $o['operator'], $o['fragments'], $o['prefixes'], $o['kind'], $o['forgedEligible'] ) ) {
				return null;
			}
			if ( ! is_string( $o['id'] ) || ! is_string( $o['operator'] ) || ! self::strings( $o['fragments'] ) || ! self::all_prefixes( $o['prefixes'] ) ) {
				return null;
			}
			// An empty fragment is a substring of every user-agent, a person's included.
			if ( in_array( '', $o['fragments'], true ) ) {
				return null;
			}
			if ( ! in_array( $o['kind'], self::KINDS, true ) || ! is_bool( $o['forgedEligible'] ) ) {
				return null;
			}
			$fetched = array_key_exists( 'fetchedAt', $o ) ? $o['fetchedAt'] : null;
			if ( null !== $fetched && ! is_string( $fetched ) ) {
				return null;
			}
			$operators[] = array(
				'id'             => $o['id'],
				'operator'       => $o['operator'],
				'fragments'      => array_map( 'strtolower', array_values( $o['fragments'] ) ),
				'kind'           => $o['kind'],
				'forgedEligible' => $o['forgedEligible'],
				'fetchedAt'      => $fetched,
				'prefixes'       => array_values( $o['prefixes'] ),
			);
		}
		return array(
			'version'     => 1,
			'generatedAt' => $raw['generatedAt'],
			'proxies'     => $proxies,
			'operators'   => $operators,
		);
	}

	/**
	 * Compile a validated document for membership checks.
	 *
	 * @param array $doc From validate().
	 * @return array ['operators' => [id => op], 'table' => [op, ...], 'proxies' => [name => compiled]]
	 */
	public static function compile( array $doc ) {
		$table = array();
		$by_id = array();
		foreach ( $doc['operators'] as $o ) {
			$ts = null === $o['fetchedAt'] ? false : strtotime( $o['fetchedAt'] );
			$op = array(
				'id'         => $o['id'],
				'operator'   => $o['operator'],
				'fragments'  => $o['fragments'],
				'kind'       => $o['kind'],
				'eligible'   => $o['forgedEligible'],
				'fetched_at' => false === $ts ? null : $ts,
				'set'        => Naulon_Ip::compile( $o['prefixes'] ),
			);
			$table[]          = $op;
			$by_id[ $o['id'] ] = $op;
		}
		$proxies = array();
		foreach ( $doc['proxies'] as $name => $list ) {
			$proxies[ $name ] = Naulon_Ip::compile( $list );
		}
		return array(
			'operators' => $by_id,
			'table'     => $table,
			'proxies'   => $proxies,
		);
	}

	/**
	 * Whether an operator's ranges are recent enough to accuse with.
	 *
	 * @param array $op  A compiled operator.
	 * @param int   $now Unix seconds.
	 * @return bool
	 */
	public static function is_fresh( array $op, $now ) {
		return null !== $op['fetched_at'] && $now - $op['fetched_at'] <= self::FRESH_SECONDS;
	}

	/**
	 * Whether the stored copy should be fetched again.
	 *
	 * @param array|null $stored The option value.
	 * @param int        $now    Unix seconds.
	 * @return bool
	 */
	public static function is_due( $stored, $now ) {
		if ( null === self::from_stored( $stored ) || ! isset( $stored['stored_at'] ) ) {
			return true;
		}
		return $now - (int) $stored['stored_at'] > self::REFRESH_SECONDS;
	}

	/**
	 * The option value to write after a fetch, or null to keep what is stored. Every failure,
	 * including a document that fails validation, keeps the last good copy.
	 *
	 * @param array $fetch Naulon_Client::crawler_ranges() result.
	 * @param int   $now   Unix seconds.
	 * @return array|null
	 */
	public static function next_store( array $fetch, $now ) {
		if ( empty( $fetch['ok'] ) ) {
			return null;
		}
		$doc = self::validate( isset( $fetch['body'] ) ? $fetch['body'] : null );
		if ( null === $doc ) {
			return null;
		}
		return array(
			'v'         => self::STORE_VERSION,
			'compiled'  => self::pack( self::compile( $doc ) ),
			'stored_at' => $now,
		);
	}

	/**
	 * The compiled form as an option can hold it. WordPress refuses to write a value that is not
	 * valid UTF-8 and says nothing, so packed address bytes are stored as hex, and the operator
	 * table is stored once (the by-id map is rebuilt on read).
	 *
	 * @param array $compiled From compile().
	 * @return array
	 */
	private static function pack( array $compiled ) {
		$set = static function ( array $cidrs ) {
			$out = array();
			foreach ( $cidrs as $c ) {
				$out[] = $c['family'] . '/' . bin2hex( $c['net'] ) . '/' . $c['bits'];
			}
			return $out;
		};
		$table = array();
		foreach ( $compiled['table'] as $op ) {
			$op['set'] = $set( $op['set'] );
			$table[]   = $op;
		}
		$proxies = array();
		foreach ( $compiled['proxies'] as $name => $cidrs ) {
			$proxies[ $name ] = $set( $cidrs );
		}
		return array(
			'table'   => $table,
			'proxies' => $proxies,
		);
	}

	/**
	 * Inverse of pack(), or null when the value is not one pack() wrote.
	 *
	 * @param mixed $packed Stored value.
	 * @return array|null As compile().
	 */
	private static function unpack( $packed ) {
		if ( ! is_array( $packed ) || ! isset( $packed['table'], $packed['proxies'] ) || ! is_array( $packed['table'] ) || ! is_array( $packed['proxies'] ) ) {
			return null;
		}
		$set = static function ( $list ) {
			if ( ! is_array( $list ) ) {
				return null;
			}
			$out = array();
			foreach ( $list as $item ) {
				$parts = is_string( $item ) ? explode( '/', $item ) : array();
				if ( 3 !== count( $parts ) ) {
					return null;
				}
				$bits  = (int) $parts[2];
				$out[] = array(
					'family' => (int) $parts[0],
					'net'    => (string) hex2bin( $parts[1] ),
					'bits'   => $bits,
					'whole'  => intdiv( $bits, 8 ),
					'rmask'  => ( 0xff << ( 8 - $bits % 8 ) ) & 0xff,
				);
			}
			return $out;
		};
		$table = array();
		$by_id = array();
		foreach ( $packed['table'] as $op ) {
			if ( ! is_array( $op ) || ! isset( $op['id'], $op['set'] ) ) {
				return null;
			}
			$op['set'] = $set( $op['set'] );
			if ( null === $op['set'] ) {
				return null;
			}
			$table[]            = $op;
			$by_id[ $op['id'] ] = $op;
		}
		$proxies = array();
		foreach ( $packed['proxies'] as $name => $list ) {
			$proxies[ $name ] = $set( $list );
			if ( null === $proxies[ $name ] ) {
				return null;
			}
		}
		return array(
			'operators' => $by_id,
			'table'     => $table,
			'proxies'   => $proxies,
		);
	}

	/**
	 * The compiled ranges inside a stored option value, or null when it holds none. Only
	 * next_store() writes this shape, and only after validate() passed, so it is read back as is.
	 *
	 * @param mixed $stored The option value.
	 * @return array|null
	 */
	public static function from_stored( $stored ) {
		if ( ! is_array( $stored ) || ! isset( $stored['v'], $stored['compiled'] ) || self::STORE_VERSION !== $stored['v'] ) {
			return null;
		}
		return self::unpack( $stored['compiled'] );
	}

	/**
	 * The compiled ranges, or null when nothing valid is stored. Memoised for the request.
	 *
	 * @return array|null
	 */
	public function current() {
		if ( false !== $this->compiled ) {
			return $this->compiled;
		}
		$this->compiled = self::from_stored( get_option( self::OPTION ) );
		return $this->compiled;
	}

	/**
	 * Fetch and store the document when the stored copy is missing or old. Cron and admin only.
	 */
	public function refresh_if_stale() {
		$stored = get_option( self::OPTION );
		$now    = time();
		if ( ! self::is_due( $stored, $now ) ) {
			return;
		}
		$next = self::next_store( Naulon_Client::instance()->crawler_ranges(), $now );
		if ( null !== $next ) {
			update_option( self::OPTION, $next, false );
			$this->compiled = false;
		}
	}

	/**
	 * @param mixed $list Candidate list.
	 * @return bool
	 */
	private static function strings( $list ) {
		if ( ! is_array( $list ) ) {
			return false;
		}
		foreach ( $list as $s ) {
			if ( ! is_string( $s ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Every entry is a prefix that passes the per-family minimums.
	 *
	 * @param mixed $list Candidate list.
	 * @return bool
	 */
	private static function all_prefixes( $list ) {
		if ( ! self::strings( $list ) ) {
			return false;
		}
		foreach ( $list as $s ) {
			if ( null === Naulon_Ip::parse_cidr( $s ) ) {
				return false;
			}
		}
		return true;
	}
}
