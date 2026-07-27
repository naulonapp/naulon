<?php
/**
 * The money primitives of the ledger, with no database in the way.
 *
 * Everything here defends one rule: an amount is an integer of micro-USDC, and anything that is
 * not unambiguously that is refused rather than coerced. A float that sneaks into a payout column
 * does not throw — it pays the wrong number, quietly, forever.
 *
 * @package naulon
 */

class LedgerMoneyTest extends PHPUnit\Framework\TestCase {

	// ── Parsing ──────────────────────────────────────────────────────────────────────────────

	public function test_a_digit_string_is_the_canonical_form() {
		$this->assertSame( 5000, Naulon_Ledger::atomic_or_null( '5000' ) );
		$this->assertSame( 0, Naulon_Ledger::atomic_or_null( '0' ) );
	}

	public function test_an_integer_is_accepted() {
		$this->assertSame( 5000, Naulon_Ledger::atomic_or_null( 5000 ) );
	}

	public function test_a_decimal_is_refused_rather_than_truncated() {
		// "0.005" is a USDC amount, not an atomic one. Truncating it to 0 would record a payment
		// of nothing; rounding it would invent a number nobody agreed to.
		$this->assertNull( Naulon_Ledger::atomic_or_null( '0.005' ) );
		$this->assertNull( Naulon_Ledger::atomic_or_null( 0.005 ) );
	}

	public function test_scientific_notation_and_negatives_are_refused() {
		$this->assertNull( Naulon_Ledger::atomic_or_null( '1e6' ) );
		$this->assertNull( Naulon_Ledger::atomic_or_null( '-5000' ) );
		$this->assertNull( Naulon_Ledger::atomic_or_null( -5000 ) );
	}

	public function test_junk_is_refused() {
		$this->assertNull( Naulon_Ledger::atomic_or_null( '5000; DROP TABLE' ) );
		$this->assertNull( Naulon_Ledger::atomic_or_null( null ) );
		$this->assertNull( Naulon_Ledger::atomic_or_null( array( 5000 ) ) );
	}

	// ── Formatting ───────────────────────────────────────────────────────────────────────────

	public function test_formatting_keeps_all_six_decimals() {
		// A half-cent toll must not display as 0.01 or as 0. Six decimals is what USDC has and
		// what a per-article price actually uses.
		$this->assertSame( '0.005000', Naulon_Ledger::format_usdc( 5000 ) );
		$this->assertSame( '0.000001', Naulon_Ledger::format_usdc( 1 ) );
		$this->assertSame( '0.000000', Naulon_Ledger::format_usdc( 0 ) );
	}

	public function test_formatting_crosses_the_whole_unit_correctly() {
		$this->assertSame( '1.000000', Naulon_Ledger::format_usdc( 1000000 ) );
		$this->assertSame( '1.500000', Naulon_Ledger::format_usdc( 1500000 ) );
		$this->assertSame( '12.345678', Naulon_Ledger::format_usdc( 12345678 ) );
	}

	public function test_an_unparseable_amount_formats_as_zero_not_as_a_guess() {
		$this->assertSame( '0.000000', Naulon_Ledger::format_usdc( 'not a number' ) );
	}

	// ── Settlement semantics ─────────────────────────────────────────────────────────────────

	public function test_the_author_leg_is_settled_and_the_rest_are_pending_under_the_declared_mode() {
		$mode = Naulon_Ledger::MODE_AUTHOR_SYNC;
		$this->assertSame( Naulon_Ledger::STATUS_SETTLED, Naulon_Ledger::leg_status( 0, $mode ) );
		$this->assertSame( Naulon_Ledger::STATUS_PENDING, Naulon_Ledger::leg_status( 1, $mode ) );
		$this->assertSame( Naulon_Ledger::STATUS_PENDING, Naulon_Ledger::leg_status( 7, $mode ) );
	}

	public function test_a_single_leg_402_with_no_declaration_is_settled() {
		// A plain single-author 402 carries no extension block at all, and its one leg is the
		// synchronous one.
		$this->assertSame( Naulon_Ledger::STATUS_SETTLED, Naulon_Ledger::leg_status( 0, '' ) );
	}

	public function test_extra_legs_with_no_declaration_are_unknown_rather_than_assumed() {
		$this->assertSame( Naulon_Ledger::STATUS_UNKNOWN, Naulon_Ledger::leg_status( 1, '' ) );
	}

	public function test_an_unrecognized_declaration_is_never_reported_as_settled() {
		// If the protocol grows a mode we do not know, saying "settled" would be a lie about
		// money. Saying "unknown" is only unhelpful.
		$this->assertSame( Naulon_Ledger::STATUS_UNKNOWN, Naulon_Ledger::leg_status( 0, 'all-legs-deferred' ) );
		$this->assertSame( Naulon_Ledger::STATUS_UNKNOWN, Naulon_Ledger::leg_status( 3, 'all-legs-deferred' ) );
	}

	// ── Reading the 402 ──────────────────────────────────────────────────────────────────────

	public function test_the_settlement_mode_is_read_out_of_the_402() {
		$header = base64_encode(
			wp_json_encode_stub(
				array(
					'x402Version' => 2,
					'accepts'     => array( array( 'amount' => '5000', 'payTo' => '0xabc' ) ),
					'extensions'  => array(
						'naulonLegs' => array(
							'version'    => 1,
							'settlement' => 'author-sync-rest-deferred',
						),
					),
				)
			)
		);
		$this->assertSame( 'author-sync-rest-deferred', Naulon_Ledger::mode_from_header( $header ) );
	}

	public function test_a_402_with_no_extension_block_has_no_mode() {
		$header = base64_encode( wp_json_encode_stub( array( 'accepts' => array( array( 'amount' => '5000' ) ) ) ) );
		$this->assertSame( '', Naulon_Ledger::mode_from_header( $header ) );
	}

	public function test_garbage_decodes_to_nothing_rather_than_throwing() {
		$this->assertNull( Naulon_Ledger::decode_402( 'not base64 at all !!!' ) );
		$this->assertNull( Naulon_Ledger::decode_402( base64_encode( 'not json' ) ) );
		$this->assertNull( Naulon_Ledger::decode_402( '' ) );
		$this->assertSame( '', Naulon_Ledger::mode_from_header( '' ) );
	}

	public function test_the_price_and_payee_can_be_read_back_for_display() {
		$header = base64_encode(
			wp_json_encode_stub(
				array(
					'accepts' => array(
						array(
							'amount'  => '5000',
							'payTo'   => '0x1111111111111111111111111111111111111111',
							'network' => 'eip155:84532',
						),
					),
				)
			)
		);
		$decoded = Naulon_Ledger::decode_402( $header );
		$this->assertSame( '5000', $decoded['accepts'][0]['amount'] );
		$this->assertSame( '0.005000', Naulon_Ledger::format_usdc( $decoded['accepts'][0]['amount'] ) );
	}
}

/**
 * json_encode under a name that will never collide with WordPress's own.
 *
 * @param array $value Value.
 * @return string
 */
function wp_json_encode_stub( array $value ) {
	return json_encode( $value ); // phpcs:ignore WordPress.WP.AlternativeFunctions -- test fixture, no WordPress loaded.
}
