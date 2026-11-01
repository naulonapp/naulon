<?php
/**
 * What the setup screen says when it checks a self-hosted gate's address and key, before either is
 * stored. Only a gate that answers the key and says it is self-hosted is accepted.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class GateCheckTest extends TestCase {

	private static function check( $status, $body = null, $error = '' ) {
		return array(
			'ok'     => $status >= 200 && $status < 300,
			'status' => $status,
			'body'   => $body,
			'error'  => $error,
		);
	}

	public function test_a_self_hosted_gate_that_accepts_the_key_is_accepted() {
		$this->assertSame( '', Naulon_Key::gate_check_error( self::check( 200, array( 'selfHosted' => true ) ) ) );
	}

	public function test_a_hosted_plane_answering_at_that_address_is_refused() {
		$this->assertStringContainsString( 'not a self-hosted gate', Naulon_Key::gate_check_error( self::check( 200, array( 'selfHosted' => false ) ) ) );
		$this->assertStringContainsString( 'not a self-hosted gate', Naulon_Key::gate_check_error( self::check( 200, array( 'hosts' => array() ) ) ) );
	}

	public function test_a_refused_key_names_the_variable_to_copy() {
		$this->assertStringContainsString( 'NAULON_ENFORCE_KEY', Naulon_Key::gate_check_error( self::check( 401 ) ) );
	}

	public function test_a_gate_without_the_api_says_how_to_turn_it_on() {
		$this->assertStringContainsString( 'NAULON_ENFORCE_KEY', Naulon_Key::gate_check_error( self::check( 404 ) ) );
	}

	public function test_nothing_answering_reports_the_transport_error() {
		$this->assertStringContainsString( 'connection refused', Naulon_Key::gate_check_error( self::check( 0, null, 'connection refused' ) ) );
	}

	public function test_an_empty_key_is_refused_before_any_request() {
		$this->assertTrue( Naulon_Key::looks_like_gate_key( str_repeat( 'k', 32 ) ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_key( str_repeat( 'k', 31 ) ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_key( '' ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_key( null ) );
	}

	public function test_a_site_the_gate_does_not_serve_is_named_as_such_not_as_a_bad_key() {
		$message = Naulon_Key::gate_check_error( self::check( 403 ) );
		$this->assertStringContainsString( 'does not serve this site', $message );
		$this->assertStringNotContainsString( 'refused that key', $message );
	}

	public function test_a_gate_key_is_any_printable_run_of_32_or_more_characters() {
		$this->assertTrue( Naulon_Key::looks_like_gate_key( str_repeat( 'a', 30 ) . '%2F' ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_key( str_repeat( 'a', 31 ) . ' b' ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_key( str_repeat( 'a', 32 ) . "\n" ) );
	}
}
