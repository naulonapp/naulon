<?php
/**
 * The gate's merged crawler-ranges document: validation, compilation, freshness and what the
 * store keeps. Ports the compileRanges / isFresh / parseRangesDocument cases from
 * packages/shared/src/crawlerRanges.test.ts and adds the refusals a hostile gate needs.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class RangesTest extends TestCase {

	const T0 = 1790812800; // 2026-10-01T00:00:00Z

	private function doc( $fetched_at ) {
		return array(
			'version'     => 1,
			'generatedAt' => gmdate( 'c', self::T0 ),
			'proxies'     => array( 'cloudflare' => array( '173.245.48.0/20' ) ),
			'operators'   => array(
				array(
					'id'             => 'google',
					'operator'       => 'Google',
					'fragments'      => array( 'Googlebot' ),
					'kind'           => 'ranges',
					'forgedEligible' => true,
					'fetchedAt'      => $fetched_at,
					'prefixes'       => array( '66.249.64.0/27', '2001:4860:4801:10::/64' ),
				),
			),
			'sources'     => array(),
		);
	}

	public function test_compile_and_is_fresh() {
		$c = Naulon_Ranges::compile( Naulon_Ranges::validate( $this->doc( gmdate( 'Y-m-d\TH:i:s.000\Z', self::T0 ) ) ) );
		$g = $c['operators']['google'];
		$this->assertTrue( Naulon_Ip::in_any( Naulon_Ip::parse( '66.249.64.3' ), $g['set'] ) );
		$this->assertSame( array( 'googlebot' ), $g['fragments'] );
		$this->assertTrue( Naulon_Ranges::is_fresh( $g, self::T0 + Naulon_Ranges::FRESH_SECONDS ) );
		$this->assertFalse( Naulon_Ranges::is_fresh( $g, self::T0 + Naulon_Ranges::FRESH_SECONDS + 1 ) );
		$null = Naulon_Ranges::compile( Naulon_Ranges::validate( $this->doc( null ) ) );
		$this->assertFalse( Naulon_Ranges::is_fresh( $null['operators']['google'], self::T0 ) );
		$this->assertTrue( Naulon_Ip::in_any( Naulon_Ip::parse( '173.245.48.9' ), $c['proxies']['cloudflare'] ) );
		$this->assertSame( 'google', $c['table'][0]['id'] );
	}

	public function test_validate_rejects_wrong_shapes() {
		$this->assertNotNull( Naulon_Ranges::validate( json_decode( json_encode( $this->doc( null ) ), true ) ) );
		$this->assertNull( Naulon_Ranges::validate( array( 'version' => 2 ) ) );
		$this->assertNull( Naulon_Ranges::validate( array( 'version' => 1, 'operators' => 'x' ) ) );
		$this->assertNull( Naulon_Ranges::validate( null ) );
		$this->assertNull( Naulon_Ranges::validate( 'a string' ) );
	}

	/** A hostile gate must not get a partial win: one /0 refuses the whole document. */
	public function test_one_broad_prefix_refuses_the_whole_document() {
		$d                              = $this->doc( null );
		$d['operators'][0]['prefixes'][] = '0.0.0.0/0';
		$this->assertNull( Naulon_Ranges::validate( $d ) );
		$d                             = $this->doc( null );
		$d['proxies']['cloudflare'][] = '::/0';
		$this->assertNull( Naulon_Ranges::validate( $d ) );
	}

	public function test_an_oversized_document_is_refused() {
		$d = $this->doc( null );
		for ( $i = 0; $i < 120000; $i++ ) {
			$d['operators'][0]['prefixes'][] = '66.249.64.0/27';
		}
		$this->assertGreaterThan( Naulon_Ranges::MAX_BYTES, strlen( json_encode( $d ) ) );
		$this->assertNull( Naulon_Ranges::validate( $d ) );
	}

	public function test_store_keeps_the_last_good_copy_on_every_failure() {
		$hostile = $this->doc( null );
		$hostile['operators'][0]['prefixes'][] = '0.0.0.0/0';
		$this->assertNull( Naulon_Ranges::next_store( array( 'ok' => true, 'body' => $hostile ), self::T0 + 1 ) );
		$this->assertNull( Naulon_Ranges::next_store( array( 'ok' => false, 'body' => null ), self::T0 + 1 ) );
		$this->assertNull( Naulon_Ranges::next_store( array( 'ok' => true, 'body' => array( 'operators' => 5 ) ), self::T0 + 1 ) );
		$fresh = Naulon_Ranges::next_store( array( 'ok' => true, 'body' => $this->doc( null ) ), self::T0 + 1 );
		$this->assertSame( self::T0 + 1, $fresh['stored_at'] );
	}

	public function test_refresh_is_due_only_when_missing_or_old() {
		$this->assertTrue( Naulon_Ranges::is_due( null, self::T0 ) );
		$stored = Naulon_Ranges::next_store( array( 'ok' => true, 'body' => $this->doc( null ) ), self::T0 );
		$this->assertFalse( Naulon_Ranges::is_due( $stored, self::T0 + Naulon_Ranges::REFRESH_SECONDS ) );
		$this->assertTrue( Naulon_Ranges::is_due( $stored, self::T0 + Naulon_Ranges::REFRESH_SECONDS + 1 ) );
	}

	/**
	 * The document is validated and compiled once, when it is stored, and a crawler request only
	 * reads the compiled form back. Revalidating 1,200 prefixes on every crawler hit bought nothing.
	 */
	public function test_the_stored_copy_carries_the_compiled_form() {
		$stored = Naulon_Ranges::next_store( array( 'ok' => true, 'body' => $this->doc( null ) ), self::T0 );
		$this->assertSame( Naulon_Ranges::compile( Naulon_Ranges::validate( $this->doc( null ) ) ), Naulon_Ranges::from_stored( $stored ) );
		// It survives the option round trip, binary prefix bytes included.
		$this->assertSame( Naulon_Ranges::from_stored( $stored ), Naulon_Ranges::from_stored( unserialize( serialize( $stored ) ) ) ); // phpcs:ignore
	}

	/** A copy written by an earlier plugin version has no compiled form: unread, and due now. */
	public function test_an_older_stored_shape_is_ignored_and_refetched() {
		$old = array(
			'doc'       => $this->doc( null ),
			'stored_at' => self::T0,
		);
		$this->assertNull( Naulon_Ranges::from_stored( $old ) );
		$this->assertTrue( Naulon_Ranges::is_due( $old, self::T0 + 1 ) );
		$this->assertNull( Naulon_Ranges::from_stored( false ) );
	}

	/**
	 * WordPress refuses to write an option whose serialized form is not valid UTF-8 (wpdb strips
	 * invalid text and the write fails silently), so packed address bytes must never reach it.
	 */
	public function test_the_stored_copy_is_valid_utf8() {
		$stored = Naulon_Ranges::next_store( array( 'ok' => true, 'body' => $this->doc( null ) ), self::T0 );
		$this->assertSame( 1, preg_match( '//u', serialize( $stored ) ) ); // phpcs:ignore
	}

	public function test_an_empty_proxy_list_or_an_empty_fragment_refuses_the_document() {
		$d                        = $this->doc( null );
		$d['proxies']['cloudflare'] = array();
		$this->assertNull( Naulon_Ranges::validate( $d ) );
		$d                                = $this->doc( null );
		$d['operators'][0]['fragments'] = array( '' );
		$this->assertNull( Naulon_Ranges::validate( $d ) );
	}
}
