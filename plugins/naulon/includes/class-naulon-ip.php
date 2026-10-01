<?php
/**
 * Address and prefix math for the crawler identity check, ported from
 * packages/shared/src/ipRange.ts. Addresses are packed binary strings (4 or 16 bytes) so one code
 * path compares both families. An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is normalised to IPv4,
 * because the same caller can reach a server in either spelling.
 *
 * The parser is hand-written rather than filter_var(): the TS parser reads a leading-zero octet as
 * decimal and filter_var refuses it, and the two runtimes must agree on every input.
 *
 * Pure functions, no WordPress calls.
 *
 * @package naulon
 */

defined( 'ABSPATH' ) || exit;

class Naulon_Ip {

	/** A prefix broader than this cannot be one crawler's address space. */
	const MIN_PREFIX_V4 = 12;
	const MIN_PREFIX_V6 = 28;

	/** Never a caller's own address: loopback, private, CGNAT, link-local, documentation, multicast, reserved. */
	const RESERVED = array(
		'0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
		'192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
		'203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
		'::/128', '::1/128', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8',
	);

	/** @var array|null Compiled RESERVED, built once per request. */
	private static $reserved = null;

	/**
	 * Parse an address. Mapped IPv6 comes back as family 4.
	 *
	 * @param string $s Address text.
	 * @return array|null ['family' => 4|6, 'bytes' => packed string]
	 */
	public static function parse( $s ) {
		$ip = self::parse_raw( $s );
		if ( null !== $ip && self::is_mapped( $ip ) ) {
			return array(
				'family' => 4,
				'bytes'  => substr( $ip['bytes'], 12 ),
			);
		}
		return $ip;
	}

	/**
	 * A caller's address as a header carries it: optionally quoted, an IPv6 bracketed, either with a
	 * port (RFC 7239, and Azure's bare `a.b.c.d:port`). The port names the caller's socket, not a
	 * different caller, so it is dropped. Mirrors parseClientAddress in ipRange.ts.
	 *
	 * @param string $s Header value (one entry).
	 * @return array|null As parse().
	 */
	public static function parse_client_address( $s ) {
		if ( ! is_string( $s ) ) {
			return null;
		}
		$v   = trim( $s );
		$len = strlen( $v );
		if ( $len >= 2 && '"' === $v[0] && '"' === $v[ $len - 1 ] ) {
			$v = trim( substr( $v, 1, -1 ) );
		}
		if ( preg_match( '/^\[([^\]]+)\](?::\d{1,5})?$/D', $v, $m ) ) {
			return self::parse( $m[1] );
		}
		if ( preg_match( '/^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/D', $v, $m ) ) {
			return self::parse( $m[1] );
		}
		return self::parse( $v );
	}

	/**
	 * Parse a CIDR prefix, masking host bits off the network. Refuses a prefix broader than the
	 * per-family minimum.
	 *
	 * @param string $s    Prefix text, `addr/len`.
	 * @param int    $min4 Narrowest allowed IPv4 length.
	 * @param int    $min6 Narrowest allowed IPv6 length.
	 * @return array|null ['family' => 4|6, 'net' => packed string, 'bits' => int]
	 */
	public static function parse_cidr( $s, $min4 = self::MIN_PREFIX_V4, $min6 = self::MIN_PREFIX_V6 ) {
		if ( ! is_string( $s ) ) {
			return null;
		}
		$slash = strpos( $s, '/' );
		if ( false === $slash ) {
			return null;
		}
		$len = trim( substr( $s, $slash + 1 ) );
		if ( ! preg_match( '/^\d{1,3}$/D', $len ) ) {
			return null;
		}
		$bits = (int) $len;
		$ip   = self::parse_raw( substr( $s, 0, $slash ) );
		if ( null === $ip ) {
			return null;
		}
		if ( self::is_mapped( $ip ) && $bits >= 96 ) {
			$ip    = array(
				'family' => 4,
				'bytes'  => substr( $ip['bytes'], 12 ),
			);
			$bits -= 96;
		}
		$total = 4 === $ip['family'] ? 32 : 128;
		if ( $bits > $total ) {
			return null;
		}
		$min = 4 === $ip['family'] ? $min4 : $min6;
		if ( $bits < $min ) {
			return null;
		}
		$net = self::mask( $ip['bytes'], $bits );
		return array(
			'family' => $ip['family'],
			'net'    => $net,
			'bits'   => $bits,
			// Precomputed for in(): the whole bytes to compare, and the mask for the partial one.
			'whole'  => intdiv( $bits, 8 ),
			'rmask'  => ( 0xff << ( 8 - $bits % 8 ) ) & 0xff,
		);
	}

	/**
	 * Whether an address is inside a prefix.
	 *
	 * @param array $ip   From parse().
	 * @param array $cidr From parse_cidr().
	 * @return bool
	 */
	public static function in( array $ip, array $cidr ) {
		if ( $ip['family'] !== $cidr['family'] ) {
			return false;
		}
		$whole = $cidr['whole'];
		if ( 0 !== strncmp( $ip['bytes'], $cidr['net'], $whole ) ) {
			return false;
		}
		if ( 0 === $cidr['bits'] % 8 ) {
			return true;
		}
		return ( ord( $ip['bytes'][ $whole ] ) & $cidr['rmask'] ) === ord( $cidr['net'][ $whole ] );
	}

	/**
	 * Compile prefix strings into a list of cidrs, dropping any that do not parse.
	 *
	 * @param array $prefixes Prefix strings.
	 * @param int   $min4     Narrowest allowed IPv4 length.
	 * @param int   $min6     Narrowest allowed IPv6 length.
	 * @return array
	 */
	public static function compile( array $prefixes, $min4 = self::MIN_PREFIX_V4, $min6 = self::MIN_PREFIX_V6 ) {
		$out = array();
		foreach ( $prefixes as $p ) {
			$c = self::parse_cidr( $p, $min4, $min6 );
			if ( null !== $c ) {
				$out[] = $c;
			}
		}
		return $out;
	}

	/**
	 * Whether an address is inside any compiled prefix. A linear scan: a full operator table is
	 * about 1,200 prefixes and a request checks at most a few operators.
	 *
	 * @param array $ip       From parse().
	 * @param array $compiled From compile().
	 * @return bool
	 */
	public static function in_any( array $ip, array $compiled ) {
		// in() inlined: this loop is the hot path, and a call per prefix doubles its cost.
		$fam   = $ip['family'];
		$bytes = $ip['bytes'];
		foreach ( $compiled as $c ) {
			if ( $fam !== $c['family'] || 0 !== strncmp( $bytes, $c['net'], $c['whole'] ) ) {
				continue;
			}
			if ( 0 === $c['bits'] % 8 || ( ord( $bytes[ $c['whole'] ] ) & $c['rmask'] ) === ord( $c['net'][ $c['whole'] ] ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * True when the address can be a caller's own public address. An address inside a proxy's
	 * ranges is the proxy speaking, not the caller.
	 *
	 * @param array $ip         From parse().
	 * @param array $proxy_sets Compiled prefix lists of CDNs and proxies.
	 * @return bool
	 */
	public static function usable( array $ip, array $proxy_sets ) {
		if ( null === self::$reserved ) {
			self::$reserved = self::compile( self::RESERVED, 0, 0 );
		}
		if ( self::in_any( $ip, self::$reserved ) ) {
			return false;
		}
		foreach ( $proxy_sets as $set ) {
			if ( self::in_any( $ip, $set ) ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * The /24 or /48 an address sits in: enough to tell operators apart, not enough to name a host.
	 *
	 * @param array $ip From parse().
	 * @return string
	 */
	public static function truncate( array $ip ) {
		$b = $ip['bytes'];
		if ( 4 === $ip['family'] ) {
			return ord( $b[0] ) . '.' . ord( $b[1] ) . '.' . ord( $b[2] ) . '.0/24';
		}
		$groups = array();
		for ( $i = 0; $i < 6; $i += 2 ) {
			$groups[] = dechex( ( ord( $b[ $i ] ) << 8 ) | ord( $b[ $i + 1 ] ) );
		}
		return implode( ':', $groups ) . '::/48';
	}

	/**
	 * Parse without mapping.
	 *
	 * @param mixed $input Address text.
	 * @return array|null
	 */
	private static function parse_raw( $input ) {
		if ( ! is_string( $input ) ) {
			return null;
		}
		$s = trim( $input );
		if ( strlen( $s ) >= 2 && '[' === $s[0] && ']' === substr( $s, -1 ) ) {
			$s = substr( $s, 1, -1 );
		}
		if ( '' === $s ) {
			return null;
		}
		if ( false !== strpos( $s, ':' ) ) {
			$v = self::parse_v6( $s );
			return null === $v ? null : array(
				'family' => 6,
				'bytes'  => $v,
			);
		}
		$v = self::parse_v4( $s );
		return null === $v ? null : array(
			'family' => 4,
			'bytes'  => $v,
		);
	}

	/**
	 * Four decimal octets, each one to three digits and at most 255.
	 *
	 * @param string $s Text.
	 * @return string|null Four packed bytes.
	 */
	private static function parse_v4( $s ) {
		$parts = explode( '.', $s );
		if ( 4 !== count( $parts ) ) {
			return null;
		}
		$out = '';
		foreach ( $parts as $p ) {
			if ( ! preg_match( '/^\d{1,3}$/D', $p ) ) {
				return null;
			}
			$n = (int) $p;
			if ( $n > 255 ) {
				return null;
			}
			$out .= chr( $n );
		}
		return $out;
	}

	/**
	 * Eight hex groups, one `::` allowed, an optional dotted IPv4 tail and an optional zone id.
	 *
	 * @param string $input Text.
	 * @return string|null Sixteen packed bytes.
	 */
	private static function parse_v6( $input ) {
		$s   = $input;
		$pct = strpos( $s, '%' );
		if ( false !== $pct ) {
			$s = substr( $s, 0, $pct );
		}
		$tail = null;
		if ( false !== strpos( $s, '.' ) ) {
			$last = strrpos( $s, ':' );
			if ( false === $last ) {
				return null;
			}
			$tail = self::parse_v4( substr( $s, $last + 1 ) );
			if ( null === $tail ) {
				return null;
			}
			$s = substr( $s, 0, $last + 1 ) . '0:0';
		}
		$halves = explode( '::', $s );
		if ( count( $halves ) > 2 ) {
			return null;
		}
		$head = '' !== $halves[0] ? explode( ':', $halves[0] ) : array();
		$rest = ( 2 === count( $halves ) && '' !== $halves[1] ) ? explode( ':', $halves[1] ) : array();
		if ( 2 === count( $halves ) ) {
			if ( count( $head ) + count( $rest ) > 7 ) {
				return null;
			}
			$groups = array_merge( $head, array_fill( 0, 8 - count( $head ) - count( $rest ), '0' ), $rest );
		} else {
			$groups = $head;
		}
		if ( 8 !== count( $groups ) ) {
			return null;
		}
		$out = '';
		foreach ( $groups as $g ) {
			if ( ! preg_match( '/^[0-9a-f]{1,4}$/iD', $g ) ) {
				return null;
			}
			$out .= pack( 'n', hexdec( $g ) );
		}
		if ( null !== $tail ) {
			$out = substr( $out, 0, 12 ) . $tail;
		}
		return $out;
	}

	/**
	 * True for ::ffff:a.b.c.d.
	 *
	 * @param array $ip Raw parse.
	 * @return bool
	 */
	private static function is_mapped( array $ip ) {
		return 6 === $ip['family'] && ( str_repeat( "\0", 10 ) . "\xff\xff" ) === substr( $ip['bytes'], 0, 12 );
	}

	/**
	 * Zero every bit after the first $bits.
	 *
	 * @param string $bytes Packed address.
	 * @param int    $bits  Prefix length.
	 * @return string
	 */
	private static function mask( $bytes, $bits ) {
		$whole = intdiv( $bits, 8 );
		$rem   = $bits % 8;
		$len   = strlen( $bytes );
		$out   = substr( $bytes, 0, $whole );
		if ( $whole < $len ) {
			$out .= 0 === $rem ? "\0" : chr( ord( $bytes[ $whole ] ) & ( 0xff << ( 8 - $rem ) ) & 0xff );
			$out .= str_repeat( "\0", $len - $whole - 1 );
		}
		return $out;
	}
}
