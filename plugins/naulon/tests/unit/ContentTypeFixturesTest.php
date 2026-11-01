<?php
/**
 * The Content-Type the licence is served with, for every Accept header in
 * packages/shared/test-fixtures/content-type-cases.json, which the gate generates from its own
 * rslContentType().
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class ContentTypeFixturesTest extends TestCase {

	const FIXTURE = '/../../../../packages/shared/test-fixtures/content-type-cases.json';

	public function cases() {
		$doc = json_decode( file_get_contents( __DIR__ . self::FIXTURE ), true ); // phpcs:ignore
		$out = array();
		foreach ( $doc['cases'] as $c ) {
			$out[ '' === $c['accept'] ? '(no accept)' : $c['accept'] ] = array( $c['accept'], $c['contentType'] );
		}
		return $out;
	}

	/**
	 * @dataProvider cases
	 */
	public function test_case( $accept, $content_type ) {
		$this->assertSame( $content_type, Naulon_License::content_type( $accept ) );
	}
}
