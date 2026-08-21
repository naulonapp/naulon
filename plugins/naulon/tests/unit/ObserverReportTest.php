<?php
/**
 * The two pure decisions inside the audit report: what a decision is CALLED on the wire, and
 * what it says the read was WORTH.
 *
 * Both are here rather than in the wp-env suite because both are the kind of mistake that is
 * invisible in production. A wrong verdict name is accepted by the endpoint and quietly buckets
 * a 402 as a free read — the publisher's Readiness screen then keeps saying nothing is priced,
 * which is the exact symptom this whole class was written to end. A wrong price is money.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

final class ObserverReportTest extends TestCase {

	/**
	 * @dataProvider verdicts
	 * @param string      $action   The enforcer's action.
	 * @param string|null $expected What it is called on the wire.
	 */
	public function test_action_maps_to_wire_verdict( $action, $expected ) {
		$this->assertSame( $expected, Naulon_Observer::verdict_for( $action ) );
	}

	/**
	 * @return array<string, array{0:string, 1:string|null}>
	 */
	public static function verdicts() {
		return array(
			'a free read is served-free'      => array( 'free', 'served-free' ),
			'an unpaid 402 is denied'         => array( 'pay', 'denied' ),
			'a licensed re-read'              => array( 'reread', 'agent-reread' ),
			// The integrity line, asserted from this side. The hosted route refuses `paid` with a
			// 400; this asserts the plugin never even builds one, so the refusal is a backstop
			// rather than the only thing standing between a settle and a doubled earnings row.
			'a settlement reports NOTHING'    => array( 'settled', null ),
			'an unknown action reports nothing' => array( 'something-new', null ),
			'an empty action reports nothing' => array( '', null ),
		);
	}

	public function test_price_is_the_sum_of_the_legs_the_control_plane_priced() {
		$legs = array(
			array( 'requirements' => array( 'amount' => '900' ) ),
			array( 'requirements' => array( 'amount' => 100 ) ),
		);
		$this->assertSame( 1000, Naulon_Observer::legs_total( $legs ) );
	}

	public function test_price_is_an_integer_never_a_float() {
		$total = Naulon_Observer::legs_total( array( array( 'requirements' => array( 'amount' => '1' ) ) ) );
		$this->assertIsInt( $total );
	}

	/**
	 * An amount that cannot be read as a non-negative integer is skipped, exactly as the ledger
	 * skips it. Counting it as zero would understate what the read was worth, and the figure this
	 * drives is publisher-facing ("earnings missed").
	 *
	 * @dataProvider unreadable
	 * @param mixed $amount An amount that is not a non-negative integer.
	 */
	public function test_an_unreadable_amount_is_skipped_not_zeroed( $amount ) {
		$legs = array(
			array( 'requirements' => array( 'amount' => $amount ) ),
			array( 'requirements' => array( 'amount' => '250' ) ),
		);
		$this->assertSame( 250, Naulon_Observer::legs_total( $legs ) );
	}

	/**
	 * @return array<string, array{0:mixed}>
	 */
	public static function unreadable() {
		return array(
			'a float string' => array( '0.25' ),
			'a float'        => array( 0.25 ),
			'a negative'     => array( -100 ),
			'not a number'   => array( 'free' ),
			'null'           => array( null ),
		);
	}

	public function test_a_leg_without_requirements_is_skipped() {
		$this->assertSame( 0, Naulon_Observer::legs_total( array( array( 'role' => 'author' ) ) ) );
	}

	public function test_no_legs_is_no_price() {
		$this->assertSame( 0, Naulon_Observer::legs_total( array() ) );
	}
}
