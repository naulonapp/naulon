<?php
/**
 * Wallet validation — every case here is "could this address receive someone's money".
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class WalletTest extends TestCase {

	const GOOD = '0x1111111111111111111111111111111111111111';

	public function test_accepts_a_well_formed_address_in_either_case() {
		$this->assertTrue( Naulon_Wallet::is_valid( self::GOOD ) );
		$this->assertTrue( Naulon_Wallet::is_valid( '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' ) );
		$this->assertTrue( Naulon_Wallet::is_valid( '  ' . self::GOOD . '  ' ) );
	}

	public function test_refuses_the_zero_address_at_validation_time_not_at_payout_time() {
		$this->assertFalse( Naulon_Wallet::is_valid( Naulon_Wallet::ZERO_ADDRESS ) );
		$this->assertTrue( Naulon_Wallet::is_zero( '0x0000000000000000000000000000000000000000' ) );
		$this->assertNotNull( Naulon_Wallet::rejection_reason( Naulon_Wallet::ZERO_ADDRESS ) );
	}

	public function test_refuses_malformed_addresses() {
		$this->assertFalse( Naulon_Wallet::is_valid( '' ) );
		$this->assertFalse( Naulon_Wallet::is_valid( '1111111111111111111111111111111111111111' ) ); // no 0x
		$this->assertFalse( Naulon_Wallet::is_valid( '0x111' ) ); // too short
		$this->assertFalse( Naulon_Wallet::is_valid( self::GOOD . '11' ) ); // too long
		$this->assertFalse( Naulon_Wallet::is_valid( '0xzzzz111111111111111111111111111111111111' ) ); // not hex
		$this->assertFalse( Naulon_Wallet::is_valid( null ) );
		$this->assertFalse( Naulon_Wallet::is_valid( 42 ) );
	}

	public function test_normalize_lowercases_but_does_not_invent_a_checksum() {
		$this->assertSame(
			'0xabcdef0123456789abcdef0123456789abcdef01',
			Naulon_Wallet::normalize( '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01' )
		);
	}

	public function test_a_valid_address_has_no_rejection_reason() {
		$this->assertNull( Naulon_Wallet::rejection_reason( self::GOOD ) );
	}

	public function test_each_malformed_shape_gets_its_own_reason() {
		$this->assertStringContainsString( '0x', Naulon_Wallet::rejection_reason( '1111' ) );
		$this->assertStringContainsString( '42', Naulon_Wallet::rejection_reason( '0x111' ) );
		$this->assertStringContainsString( 'hex', Naulon_Wallet::rejection_reason( '0xzzzz111111111111111111111111111111111111' ) );
		$this->assertStringContainsString( 'burn', Naulon_Wallet::rejection_reason( Naulon_Wallet::ZERO_ADDRESS ) );
	}
}
