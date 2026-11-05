<?php
/**
 * The connect cases every runtime must agree on. Reads the file packages/shared/src/connect/connect.test.ts
 * and packages/python/tests/test_connect.py read.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class ConnectFixturesTest extends TestCase {

	const FIXTURE = '/../../../../packages/shared/test-fixtures/connect-cases.json';

	private static function fixture() {
		return json_decode( file_get_contents( __DIR__ . self::FIXTURE ), true ); // phpcs:ignore
	}

	public function test_pkce_matches_the_other_runtimes() {
		$this->assertSame( 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', Naulon_Connect_Protocol::code_challenge( 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' ) );
		foreach ( self::fixture()['pkce'] as $c ) {
			$this->assertSame( $c['challenge'], Naulon_Connect_Protocol::code_challenge( $c['verifier'] ) );
		}
	}

	public function test_a_short_verifier_is_refused() {
		$this->expectException( InvalidArgumentException::class );
		Naulon_Connect_Protocol::code_challenge( 'short' );
	}

	public function test_site_origins_match_the_other_runtimes() {
		foreach ( self::fixture()['siteOrigins'] as $c ) {
			$this->assertSame( $c['origin'], Naulon_Connect_Protocol::site_origin( $c['input'] ), $c['input'] );
		}
	}

	public function test_discovery_matches_the_other_runtimes() {
		foreach ( self::fixture()['discovery'] as $i => $c ) {
			$r = Naulon_Connect_Protocol::parse_discovery( $c['body'], $c['gate'] );
			$this->assertSame( $c['ok'], is_array( $r ), "case $i: " . ( is_string( $r ) ? $r : 'ok' ) );
			if ( ! $c['ok'] && isset( $c['error'] ) ) {
				$this->assertStringContainsString( $c['error'], $r, "case $i" );
			}
		}
	}

	public function test_loopback_is_this_machine_and_nothing_else() {
		foreach ( array( 'localhost', '127.0.0.1', '127.9.9.9', '[::1]', '::1' ) as $h ) {
			$this->assertTrue( Naulon_Connect_Protocol::is_loopback( $h ), $h );
		}
		foreach ( array( '10.0.0.1', '128.0.0.1', 'localhost.example.com', 'example.com' ) as $h ) {
			$this->assertFalse( Naulon_Connect_Protocol::is_loopback( $h ), $h );
		}
	}

	public function test_random_states_are_url_safe_and_long_enough() {
		$state = Naulon_Connect_Protocol::random( 24 );
		$this->assertMatchesRegularExpression( Naulon_Connect_Protocol::STATE_PATTERN, $state );
		$this->assertNotSame( $state, Naulon_Connect_Protocol::random( 24 ) );
	}
}
