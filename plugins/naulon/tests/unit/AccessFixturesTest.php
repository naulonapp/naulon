<?php
/**
 * The access decisions every in-app runtime must reach. Reads packages/shared/test-fixtures/
 * access-cases.json, which the gate generates from its own decide(), and requires
 * Naulon_Rules::access to agree on every subject, terms combination and rule variant.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class AccessFixturesTest extends TestCase {

	const FIXTURE = '/../../../../packages/shared/test-fixtures/access-cases.json';

	private static function fixture() {
		$path = __DIR__ . self::FIXTURE;
		if ( ! is_readable( $path ) ) {
			throw new RuntimeException( 'access fixture not found at ' . $path );
		}
		return json_decode( file_get_contents( $path ), true ); // phpcs:ignore
	}

	public function test_the_fixture_file_is_where_this_suite_reads_it() {
		$this->assertFileExists( __DIR__ . self::FIXTURE );
	}

	public function subjects() {
		$out = array();
		foreach ( self::fixture()['subjects'] as $s ) {
			$out[ $s['name'] ] = array( $s );
		}
		return $out;
	}

	/**
	 * @dataProvider subjects
	 */
	public function test_subject( array $s ) {
		$doc      = self::fixture();
		$variants = $doc['variants'];
		$codes    = array_flip( $doc['codes'] );
		$disagree = array();
		foreach ( $doc['ruleSets'] as $t => $set ) {
			foreach ( $variants as $v => $variant ) {
				$rules = $set['rules'];
				if ( 'none' !== $variant && null !== $s['fragment'] ) {
					$rules[ $variant ][] = $s['fragment'];
				}
				$a = Naulon_Rules::access(
					array(
						'user_agent'         => $s['ua'],
						'accept'             => $s['accept'],
						'has_payment_header' => false,
						'declared_agent_id'  => '',
						'headers'            => array(),
					),
					Naulon_Rules::normalize( $rules ),
					array()
				);
				$want = $codes[ $s['expect'][ $t * count( $variants ) + $v ] ];
				if ( $a['action'] !== $want ) {
					$disagree[] = sprintf( '%s / %s: gate %s, plugin %s', json_encode( $set['termsPolicy'] ), $variant, $want, $a['action'] ); // phpcs:ignore
				}
			}
		}
		$this->assertSame( array(), array_slice( $disagree, 0, 10 ), count( $disagree ) . ' disagreements' );
	}
}
