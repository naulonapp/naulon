<?php
/**
 * The gate's verdict vocabulary and how to read an answer, from
 * packages/shared/test-fixtures/verdict-cases.json, which the gate generates from its own
 * GATE_VERDICTS, FREE_REASONS and gateAnswer(). A runtime that reads a verdict differently from
 * the gate is how one payment ends up served by one runtime and billed again by another.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class VerdictFixturesTest extends TestCase {

	const FIXTURE = '/../../../../packages/shared/test-fixtures/verdict-cases.json';

	private static function doc() {
		return json_decode( file_get_contents( __DIR__ . self::FIXTURE ), true ); // phpcs:ignore
	}

	public function test_the_verdicts_are_the_gates() {
		$this->assertSame( self::doc()['gateVerdicts'], Naulon_Client::VERDICTS );
	}

	public function test_the_free_reasons_are_the_gates() {
		$this->assertSame( self::doc()['freeReasons'], Naulon_Observer::FREE_REASONS );
	}

	public function cases() {
		$out = array();
		foreach ( self::doc()['cases'] as $c ) {
			$out[ $c['name'] ] = array( $c['status'], $c['body'], $c['verdict'] );
		}
		return $out;
	}

	/**
	 * @dataProvider cases
	 */
	public function test_case( $status, $body, $verdict ) {
		$this->assertSame( $verdict, Naulon_Client::verdict_of( array( 'ok' => $status >= 200 && $status < 300, 'status' => $status, 'body' => $body ) ) );
	}

	public function test_no_answer_is_no_verdict() {
		$this->assertNull( Naulon_Client::verdict_of( array( 'ok' => false, 'status' => 0, 'body' => null, 'error' => 'timed out' ) ) );
	}
}
