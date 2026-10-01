<?php
/**
 * Address and prefix math, a one-for-one port of packages/shared/src/ipRange.test.ts. The two
 * runtimes must agree on every input, or the same forged claim is charged on one and free on the
 * other.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class IpTest extends TestCase {

	public function test_parse_v4_v6_mapped_bracketed_zone_and_junk() {
		$this->assertSame( array( 4, '42f94201' ), $this->fx( Naulon_Ip::parse( '66.249.66.1' ) ) );
		$this->assertSame( 6, Naulon_Ip::parse( '2001:4860:4801:10::1' )['family'] );
		$this->assertSame( array( 4, '42f94201' ), $this->fx( Naulon_Ip::parse( '::ffff:66.249.66.1' ) ) );
		$this->assertSame( 6, Naulon_Ip::parse( '[2001:db8::1]' )['family'] );
		$this->assertSame( 6, Naulon_Ip::parse( 'fe80::1%eth0' )['family'] );
		foreach ( array( '', '1.2.3', '1.2.3.256', '01.2.3.4x', '1::2::3', '1:2:3:4:5:6:7:8:9', 'gggg::', 'abc' ) as $bad ) {
			$this->assertNull( Naulon_Ip::parse( $bad ), $bad );
		}
	}

	public function test_parse_cidr_masks_host_bits_and_refuses_broad_prefixes() {
		$c = Naulon_Ip::parse_cidr( '66.249.66.7/24' );
		$this->assertSame( '42f94200', bin2hex( $c['net'] ) );
		$this->assertSame( 24, $c['bits'] );
		foreach ( array( '0.0.0.0/0', '10.0.0.0/8', '::/0', '2001:db8::/16', '1.2.3.4/33', '1.2.3.4' ) as $bad ) {
			$this->assertNull( Naulon_Ip::parse_cidr( $bad ), $bad );
		}
		$this->assertNotNull( Naulon_Ip::parse_cidr( '2001:4860:4801:10::/64' ) );
		$this->assertSame( 4, Naulon_Ip::parse_cidr( '::ffff:66.249.66.0/120' )['family'] );
	}

	public function test_membership_both_families() {
		$set = Naulon_Ip::compile( array( '66.249.64.0/27', '66.249.64.32/27', '2001:4860:4801:10::/64', 'bogus' ) );
		$this->assertCount( 3, $set );
		$this->assertTrue( Naulon_Ip::in_any( Naulon_Ip::parse( '66.249.64.40' ), $set ) );
		$this->assertFalse( Naulon_Ip::in_any( Naulon_Ip::parse( '66.249.64.64' ), $set ) );
		$this->assertTrue( Naulon_Ip::in_any( Naulon_Ip::parse( '2001:4860:4801:10::abcd' ), $set ) );
		$this->assertFalse( Naulon_Ip::in_any( Naulon_Ip::parse( '2001:4860:4801:11::1' ), $set ) );
		$this->assertTrue( Naulon_Ip::in_any( Naulon_Ip::parse( '::ffff:66.249.64.1' ), $set ) );
	}

	public function test_reserved_and_proxy_addresses_are_unusable() {
		foreach ( array( '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '169.254.1.1', '240.0.0.1', '0.1.2.3', '::1', 'fc00::1', 'fe80::1', '2001:db8::1' ) as $ip ) {
			$this->assertFalse( Naulon_Ip::usable( Naulon_Ip::parse( $ip ), array() ), $ip );
		}
		$this->assertTrue( Naulon_Ip::usable( Naulon_Ip::parse( '66.249.66.1' ), array() ) );
		$cf = Naulon_Ip::compile( array( '173.245.48.0/20' ) );
		$this->assertFalse( Naulon_Ip::usable( Naulon_Ip::parse( '173.245.48.5' ), array( $cf ) ) );
	}

	public function test_truncate() {
		$this->assertSame( '9.9.9.0/24', Naulon_Ip::truncate( Naulon_Ip::parse( '9.9.9.9' ) ) );
		$this->assertSame( '2a01:4f8:c0c::/48', Naulon_Ip::truncate( Naulon_Ip::parse( '2a01:4f8:c0c:1234::1' ) ) );
	}

	/** The TS parser accepts a leading-zero octet as decimal; PHP's filter_var would refuse it. */
	public function test_leading_zero_octet_reads_as_decimal_like_the_ts_parser() {
		$this->assertSame( array( 4, '01020304' ), $this->fx( Naulon_Ip::parse( '01.2.3.4' ) ) );
	}

	private function fx( $ip ) {
		return array( $ip['family'], bin2hex( $ip['bytes'] ) );
	}

	/** PHP's `$` matches before a trailing newline and JS's does not; the parsers must agree. */
	public function test_an_embedded_newline_is_refused_like_the_ts_parser() {
		$this->assertNull( Naulon_Ip::parse( "1.2.3\n.4" ) );
		$this->assertNull( Naulon_Ip::parse( "2001:db8:ab\n::1" ) );
		$this->assertNull( Naulon_Ip::parse_cidr( "66.249.66.0/2\n4" ) );
		$this->assertNotNull( Naulon_Ip::parse( "1.2.3.4\n" ) );
		$this->assertNotNull( Naulon_Ip::parse_cidr( "66.249.66.0/24\n" ) );
	}

	/** A header's client address: quoted, bracketed IPv6 and a port all reduce to the address. */
	public function test_parse_client_address_drops_quotes_brackets_and_port() {
		$this->assertSame( array( 4, '42f94201' ), $this->fx( Naulon_Ip::parse_client_address( '66.249.66.1:443' ) ) );
		$this->assertSame( array( 4, '42f94201' ), $this->fx( Naulon_Ip::parse_client_address( '"66.249.66.1:443"' ) ) );
		$this->assertSame( 6, Naulon_Ip::parse_client_address( '"[2001:4860:4801:10::9]:443"' )['family'] );
		$this->assertSame( 6, Naulon_Ip::parse_client_address( '2001:4860:4801:10::9' )['family'] );
		$this->assertNull( Naulon_Ip::parse_client_address( '66.249.66.1:99999x' ) );
		$this->assertNull( Naulon_Ip::parse_client_address( 'unknown' ) );
	}
}
