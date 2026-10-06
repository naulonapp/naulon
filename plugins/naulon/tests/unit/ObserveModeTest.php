<?php
/**
 * Observe mode in the plugin: a read that would get a 402 is served instead, priced and reported,
 * and a presented payment is never settled.
 *
 * @package Naulon
 */

use PHPUnit\Framework\TestCase;

final class ObserveModeTest extends TestCase {

	private function built() {
		return array(
			'header' => 'x402-header',
			'legs'   => array( array( 'requirements' => array( 'amount' => '900' ) ), array( 'requirements' => array( 'amount' => '100' ) ) ),
		);
	}

	public function test_observing_serves_and_carries_the_price_it_would_have_asked() {
		$d = Naulon_Enforcer::unpaid_decision( $this->built(), true, false, 'within', 'agent (GPTBot)' );
		$this->assertSame( 'observed', $d['action'] );
		$this->assertSame( '', $d['header'], 'no 402 header leaves an observed read' );
		$this->assertSame( 1000, $d['price_micro'] );
		$this->assertSame( 'within', $d['crawler_budget'] );
		$this->assertFalse( $d['payment_presented'] );
	}

	public function test_observing_with_a_payment_records_it_and_still_does_not_charge() {
		$d = Naulon_Enforcer::unpaid_decision( $this->built(), true, true, null, 'agent (GPTBot)' );
		$this->assertSame( 'observed', $d['action'] );
		$this->assertTrue( $d['payment_presented'] );
	}

	public function test_charging_answers_the_402_and_keeps_the_budget() {
		$d = Naulon_Enforcer::unpaid_decision( $this->built(), false, false, 'over', 'agent (GPTBot)' );
		$this->assertSame( 'pay', $d['action'] );
		$this->assertSame( 'x402-header', $d['header'] );
		$this->assertSame( 'over', $d['crawler_budget'] );
	}

	public function test_observing_with_nobody_to_pay_takes_the_price_from_the_quote() {
		$built = array( 'header' => '', 'legs' => array(), 'quote' => array( 'price' => 0.002 ) );
		$d     = Naulon_Enforcer::unpaid_decision( $built, true, false, null, 'agent (GPTBot)' );
		$this->assertSame( 'observed', $d['action'] );
		$this->assertSame( 2000, $d['price_micro'] );
	}

	public function test_charging_with_nobody_to_pay_serves_free_rather_than_an_empty_402() {
		$built = array( 'header' => '', 'legs' => array(), 'quote' => array( 'price' => 0.002 ) );
		$d     = Naulon_Enforcer::unpaid_decision( $built, false, false, null, 'agent (GPTBot)' );
		$this->assertSame( 'free', $d['action'] );
	}

	public function test_a_payee_less_ask_includes_the_fee_leg() {
		$built = array( 'header' => '', 'legs' => array(), 'quote' => array( 'price' => 0.001, 'extraLegs' => array( array( 'amount' => '100' ) ) ) );
		$this->assertSame( 1100, Naulon_Enforcer::ask_micro( $built ) );
	}
}
