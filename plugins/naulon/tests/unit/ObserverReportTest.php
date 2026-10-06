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

	/* The identity fields, and the one report allowed to say `human`. */

	private function base( array $over = array() ) {
		return array_merge(
			array(
				'resource' => 'https://example.com/a/',
				'slug'     => 'a',
				'action'   => 'free',
				'kind'     => 'read',
				'ua'       => 'Googlebot/2.1',
				'reason'   => 'seo allowlist matched "googlebot"',
			),
			$over
		);
	}

	public function test_a_crawler_claim_classified_human_reports_human_with_its_check() {
		$shaped = Naulon_Observer::shape(
			$this->base(
				array(
					'classified_as' => 'human',
					'identity'      => array(
						'check'  => 'ip-verified',
						'claims' => array( array( 'operator_id' => 'google', 'operator' => 'Google', 'fragment' => 'googlebot', 'check' => 'ip-verified' ) ),
					),
				)
			)
		);
		$this->assertSame( 'human', $shaped['classifiedAs'] );
		$this->assertSame( 'served-free', $shaped['verdict'] );
		$this->assertSame( 'ip-verified', $shaped['identityCheck'] );
		$this->assertSame( 'google', $shaped['claimedOperator'] );
		$this->assertArrayNotHasKey( 'forgedFrom', $shaped );
	}

	public function test_without_an_identity_check_the_report_is_always_agent() {
		$shaped = Naulon_Observer::shape( $this->base( array( 'classified_as' => 'human' ) ) );
		$this->assertSame( 'agent', $shaped['classifiedAs'] );
		$this->assertArrayNotHasKey( 'identityCheck', $shaped );
	}

	public function test_forged_from_rides_only_on_a_forged_report() {
		$forged = Naulon_Observer::shape(
			$this->base(
				array(
					'action'      => 'pay',
					'identity'    => array(
						'check'  => 'forged',
						'claims' => array( array( 'operator_id' => 'google', 'operator' => 'Google', 'fragment' => 'googlebot', 'check' => 'forged' ) ),
					),
					'forged_from' => '9.9.9.0/24',
				)
			)
		);
		$this->assertSame( 'forged', $forged['identityCheck'] );
		$this->assertSame( '9.9.9.0/24', $forged['forgedFrom'] );
		$this->assertSame( 'agent', $forged['classifiedAs'] );

		$verified = Naulon_Observer::shape(
			$this->base(
				array(
					'identity'    => array(
						'check'  => 'ip-verified',
						'claims' => array( array( 'operator_id' => 'google', 'operator' => 'Google', 'fragment' => 'googlebot', 'check' => 'ip-verified' ) ),
					),
					'forged_from' => '9.9.9.0/24',
				)
			)
		);
		$this->assertArrayNotHasKey( 'forgedFrom', $verified );
	}

	/**
	 * A crawler that read free must not wait on the control plane: its row waits in the buffer for
	 * the next agent request or the cron. Only a charged or refused row is sent in-request.
	 */
	public function test_a_free_crawler_row_is_deferred_and_a_charged_one_is_not() {
		$this->assertTrue( Naulon_Observer::defers( array( 'classifiedAs' => 'human' ) ) );
		$this->assertFalse( Naulon_Observer::defers( array( 'classifiedAs' => 'agent' ) ) );
	}

	public function test_the_deferred_buffer_keeps_the_newest_rows_only() {
		$buffer = array();
		for ( $i = 0; $i < Naulon_Observer::MAX_BATCH + 5; $i++ ) {
			$buffer = Naulon_Observer::with_deferred( $buffer, array( 'n' => $i ) );
		}
		$this->assertCount( Naulon_Observer::MAX_BATCH, $buffer );
		$this->assertSame( Naulon_Observer::MAX_BATCH + 4, end( $buffer )['n'] );
	}

	/**
	 * Arming is counted from the verified rows. A forger who floods the buffer with forged claims
	 * must not be able to push every verified row out of it and keep the site from ever arming.
	 */
	public function test_a_flood_of_unverified_rows_never_evicts_a_verified_one() {
		$buffer = Naulon_Observer::with_deferred( array(), array( 'n' => 'real', 'identityCheck' => 'ip-verified' ) );
		for ( $i = 0; $i < Naulon_Observer::MAX_BATCH * 3; $i++ ) {
			$buffer = Naulon_Observer::with_deferred( $buffer, array( 'n' => $i, 'identityCheck' => 'forged' ) );
		}
		$this->assertCount( Naulon_Observer::MAX_BATCH, $buffer );
		$this->assertContains( 'real', array_column( $buffer, 'n' ) );
		$this->assertSame( Naulon_Observer::MAX_BATCH * 3 - 1, end( $buffer )['n'] );
	}

	public function test_an_observed_read_is_reported_as_denied_and_observe_only() {
		$this->assertSame( 'denied', Naulon_Observer::verdict_for( 'observed' ) );
		$shaped = Naulon_Observer::shape(
			array(
				'resource'          => 'https://blog.example/a',
				'slug'              => 'a',
				'action'            => 'observed',
				'price_micro'       => 1000,
				'payment_presented' => true,
				'crawler_budget'    => 'within',
			)
		);
		$this->assertTrue( $shaped['observeOnly'] );
		$this->assertTrue( $shaped['paymentPresented'] );
		$this->assertSame( 'within', $shaped['crawlerBudget'] );
		$this->assertSame( 1000, $shaped['priceMicro'] );
	}

	public function test_a_402_carries_the_budget_but_never_observe_only() {
		$shaped = Naulon_Observer::shape(
			array( 'resource' => 'https://blog.example/a', 'action' => 'pay', 'price_micro' => 1000, 'crawler_budget' => 'over', 'payment_presented' => true )
		);
		$this->assertSame( 'over', $shaped['crawlerBudget'] );
		$this->assertArrayNotHasKey( 'observeOnly', $shaped );
		$this->assertArrayNotHasKey( 'paymentPresented', $shaped, 'a payment the site did not settle exists only while observing' );
	}

	/**
	 * @dataProvider budgets
	 * @param string|null $max      crawler-max-price.
	 * @param string|null $exact    crawler-exact-price.
	 * @param string|null $expected within|over|null.
	 */
	public function test_the_crawler_budget_is_read_from_the_cloudflare_headers( $max, $exact, $expected ) {
		$this->assertSame( $expected, Naulon_Observer::crawler_budget( $max, $exact, 1000 ) );
	}

	/**
	 * @return array<string, array{0:string|null, 1:string|null, 2:string|null}>
	 */
	public static function budgets() {
		return array(
			'nothing stated'                 => array( null, null, null ),
			'a ceiling above the ask'        => array( 'USD 0.01', null, 'within' ),
			'a ceiling equal to the ask'     => array( 'USD 0.001', null, 'within' ),
			'a ceiling below the ask'        => array( 'USD 0.0001', null, 'over' ),
			'the exact price as a fallback'  => array( null, 'USD 0.002', 'within' ),
			'the ceiling wins over exact'    => array( 'USD 0.0001', 'USD 1', 'over' ),
			'garbage is nothing stated'      => array( 'cheap', null, null ),
			'too many decimals is nothing'   => array( 'USD 0.0000001', null, null ),
		);
	}
}
