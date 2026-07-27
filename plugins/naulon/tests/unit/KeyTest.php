<?php
/**
 * Key format and masking — what a key looks like, and what a human is allowed to see of it.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class KeyTest extends TestCase {

	const KEY = 'nln_live_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

	public function test_recognizes_a_hosted_key_by_its_typed_prefix() {
		$this->assertTrue( Naulon_Key::looks_like_key( self::KEY ) );
		$this->assertTrue( Naulon_Key::looks_like_key( '  ' . self::KEY . ' ' ) );
	}

	public function test_rejects_non_keys() {
		$this->assertFalse( Naulon_Key::looks_like_key( 'nln_test_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' ) );
		$this->assertFalse( Naulon_Key::looks_like_key( 'https://gate.example.com' ) );
		$this->assertFalse( Naulon_Key::looks_like_key( 'nln_live_short' ) );
		$this->assertFalse( Naulon_Key::looks_like_key( '' ) );
		$this->assertFalse( Naulon_Key::looks_like_key( null ) );
	}

	public function test_accepts_a_self_host_gate_url_over_https() {
		$this->assertTrue( Naulon_Key::looks_like_gate_url( 'https://gate.example.com' ) );
		$this->assertTrue( Naulon_Key::looks_like_gate_url( 'https://gate.example.com:8500/' ) );
	}

	public function test_plain_http_is_only_allowed_for_loopback() {
		$this->assertTrue( Naulon_Key::looks_like_gate_url( 'http://localhost:8500' ) );
		$this->assertTrue( Naulon_Key::looks_like_gate_url( 'http://127.0.0.1:8500' ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_url( 'http://gate.example.com' ) );
	}

	public function test_rejects_non_urls() {
		$this->assertFalse( Naulon_Key::looks_like_gate_url( 'gate.example.com' ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_url( self::KEY ) );
		$this->assertFalse( Naulon_Key::looks_like_gate_url( null ) );
	}

	public function test_mask_shows_the_prefix_and_a_few_body_chars_never_the_tail() {
		$masked = Naulon_Key::mask( self::KEY );
		$this->assertSame( 'nln_live_a1b2…', $masked );
		// The tail is what makes a leaked preview dangerous — it must never appear.
		$this->assertStringNotContainsString( 'o5p6', $masked );
	}

	public function test_mask_never_echoes_an_arbitrary_stored_string() {
		$this->assertSame( 'gate.example.com', Naulon_Key::mask( 'https://gate.example.com/x' ) );
		$this->assertSame( '', Naulon_Key::mask( 'some-random-junk' ) );
		$this->assertSame( '', Naulon_Key::mask( '' ) );
		$this->assertSame( '', Naulon_Key::mask( null ) );
	}
}
