<?php
/**
 * The identity cases every runtime must agree on. Reads the same fixture file as
 * packages/enforce/src/identity.fixtures.test.ts and runs every case marked `php`. A case marked
 * only `ts` needs a step this plugin does not have (Web Bot Auth signature verification).
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class IdentityFixturesTest extends TestCase {

	const FIXTURE = '/../../../../packages/shared/test-fixtures/identity-cases.json';
	const NOW     = 1790812800; // 2026-10-01T00:00:00Z, the TS runner's NOW.

	private static function fixture() {
		$path = __DIR__ . self::FIXTURE;
		if ( ! is_readable( $path ) ) {
			throw new RuntimeException( 'identity fixture not found at ' . $path );
		}
		return json_decode( file_get_contents( $path ), true ); // phpcs:ignore
	}

	public function test_the_fixture_file_is_where_this_suite_reads_it() {
		$this->assertFileExists( __DIR__ . self::FIXTURE );
	}

	/** The plugin's fallback table must be the fixture's, which the TS runner holds to CRAWLER_PROOF. */
	public function test_built_in_table_mirrors_the_fixture_operators() {
		$this->assertSame( self::fixture()['operators'], Naulon_Identity::PROOF );
	}

	public function php_cases() {
		$out = array();
		foreach ( self::fixture()['cases'] as $c ) {
			if ( in_array( 'php', $c['runtimes'], true ) ) {
				$out[ $c['name'] ] = array( $c );
			}
		}
		return $out;
	}

	/**
	 * @dataProvider php_cases
	 */
	public function test_case( array $c ) {
		$compiled = null;
		$doc      = $this->doc_for( $c );
		if ( null !== $doc ) {
			$compiled = Naulon_Ranges::compile( Naulon_Ranges::validate( $doc ) );
		}
		$policy = array( 'seo_allowlist' => $c['allow'] );
		if ( isset( $c['charge'] ) ) {
			$policy['charge_list'] = $c['charge'];
		}
		$headers = array();
		foreach ( isset( $c['headers'] ) ? $c['headers'] : array() as $name => $value ) {
			$headers[ strtolower( $name ) ] = $value;
		}
		$out = Naulon_Identity::classify(
			array(
				'user_agent'         => $c['ua'],
				'has_payment_header' => false,
				'declared_agent_id'  => '',
				'accept'             => $c['accept'],
				'headers'            => $headers,
			),
			$policy,
			$c['mode'],
			$compiled,
			$c['clientIp'],
			self::NOW,
			$c['armed']
		);
		$this->assertSame( $c['expect']['kind'], $out['verdict']['kind'] );
		$this->assertSame( $c['expect']['identityCheck'], null === $out['identity'] ? null : $out['identity']['check'] );
		$forged = isset( $out['verdict']['identity'] ) && 'forged' === $out['verdict']['identity'];
		$this->assertSame( isset( $c['expect']['forged'] ) ? $c['expect']['forged'] : false, $forged );
	}

	/** Mirrors docFor() in the TS runner. */
	private function doc_for( array $c ) {
		if ( null === $c['ranges'] ) {
			return null;
		}
		$over = array();
		foreach ( $c['ranges']['operators'] as $o ) {
			$over[ $o['id'] ] = $o;
		}
		$ops = array();
		foreach ( self::fixture()['operators'] as $r ) {
			$o     = isset( $over[ $r['id'] ] ) ? $over[ $r['id'] ] : null;
			$ops[] = array(
				'id'             => $r['id'],
				'operator'       => $r['operator'],
				'fragments'      => $r['fragments'],
				'kind'           => $r['kind'],
				'forgedEligible' => ( null !== $o && isset( $o['forgedEligible'] ) ) ? $o['forgedEligible'] : $r['forgedEligible'],
				'fetchedAt'      => ( null !== $o && null !== $o['fetchedAgoHours'] ) ? gmdate( 'Y-m-d\TH:i:s.000\Z', (int) ( self::NOW - $o['fetchedAgoHours'] * 3600 ) ) : null,
				'prefixes'       => null !== $o ? $o['prefixes'] : array(),
			);
		}
		return array(
			'version'     => 1,
			'generatedAt' => gmdate( 'Y-m-d\TH:i:s.000\Z', self::NOW ),
			'proxies'     => array( 'cloudflare' => array( '173.245.48.0/20' ) ),
			'operators'   => $ops,
			'sources'     => array(),
		);
	}
}
