<?php
/**
 * The earnings ledger against a real database.
 *
 * These are money tests, so they are written from the failure end: what would have to be true for
 * this table to tell a publisher something false? An amount silently becoming zero, a retried
 * settlement counted twice, a payee's total including somebody else's leg, or a co-author's
 * authorized-but-not-yet-settled share being reported as money that has moved.
 *
 * @package naulon
 */

class LedgerTest extends WP_UnitTestCase {

	const AUTHOR_WALLET   = '0x1111111111111111111111111111111111111111';
	const COAUTHOR_WALLET = '0x2222222222222222222222222222222222222222';

	/**
	 * One legs array in the shape the control plane actually returns.
	 *
	 * @param string $author_amount   Atomic USDC for the author leg.
	 * @param string $coauthor_amount Atomic USDC for the co-author leg, or '' for none.
	 * @return array
	 */
	private function legs( $author_amount = '3000', $coauthor_amount = '2000' ) {
		$legs = array(
			array(
				'role'         => 'author',
				'requirements' => array(
					'payTo'   => self::AUTHOR_WALLET,
					'amount'  => $author_amount,
					'network' => 'eip155:84532',
				),
			),
		);
		if ( '' !== $coauthor_amount ) {
			$legs[] = array(
				'role'         => 'coauthor',
				'requirements' => array(
					'payTo'   => self::COAUTHOR_WALLET,
					'amount'  => $coauthor_amount,
					'network' => 'eip155:84532',
				),
			);
		}
		return $legs;
	}

	/**
	 * @param array $over Overrides.
	 * @return array
	 */
	private function settlement( array $over = array() ) {
		return array_merge(
			array(
				'post_id'        => 0,
				'slug'           => 'blog/a-post',
				'kind'           => 'read',
				'settlement_ref' => '0xref1',
				'payer'          => '0x9999999999999999999999999999999999999999',
				'legs'           => $this->legs(),
				'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
			),
			$over
		);
	}

	// ── Recording ────────────────────────────────────────────────────────────────────────────

	public function test_every_leg_is_recorded_with_the_amount_the_buyer_signed_for() {
		$this->assertSame( 2, Naulon_Ledger::record( $this->settlement() ) );

		$rows = Naulon_Ledger::recent( 10 );
		$this->assertCount( 2, $rows );

		$by_wallet = array();
		foreach ( $rows as $row ) {
			$by_wallet[ $row['pay_to'] ] = $row;
		}
		$this->assertSame( '3000', $by_wallet[ strtolower( self::AUTHOR_WALLET ) ]['amount_atomic'] );
		$this->assertSame( '2000', $by_wallet[ strtolower( self::COAUTHOR_WALLET ) ]['amount_atomic'] );
	}

	public function test_the_author_leg_is_settled_and_the_co_author_leg_is_only_authorized() {
		Naulon_Ledger::record( $this->settlement() );

		$this->assertSame( 3000, Naulon_Ledger::total_for_wallet( self::AUTHOR_WALLET, Naulon_Ledger::STATUS_SETTLED ) );
		$this->assertSame( 0, Naulon_Ledger::total_for_wallet( self::COAUTHOR_WALLET, Naulon_Ledger::STATUS_SETTLED ) );
		$this->assertSame( 2000, Naulon_Ledger::total_for_wallet( self::COAUTHOR_WALLET, Naulon_Ledger::STATUS_PENDING ) );
	}

	public function test_the_site_total_never_adds_authorized_money_to_settled_money() {
		Naulon_Ledger::record( $this->settlement() );

		$this->assertSame( 3000, Naulon_Ledger::site_total( Naulon_Ledger::STATUS_SETTLED ) );
		$this->assertSame( 2000, Naulon_Ledger::site_total( Naulon_Ledger::STATUS_PENDING ) );
		$this->assertSame( 5000, Naulon_Ledger::site_total( '' ) );
	}

	// ── Idempotency ──────────────────────────────────────────────────────────────────────────

	public function test_the_same_settlement_recorded_twice_counts_once() {
		// A settle that timed out on the wire and was retried must not double a payout figure.
		Naulon_Ledger::record( $this->settlement() );
		$second = Naulon_Ledger::record( $this->settlement() );

		$this->assertSame( 0, $second );
		$this->assertSame( 3000, Naulon_Ledger::total_for_wallet( self::AUTHOR_WALLET ) );
		$this->assertSame( 1, Naulon_Ledger::settlement_count() );
	}

	public function test_two_settlements_with_no_reference_do_not_collide() {
		// A missing reference must not make every such row land on the same unique key and
		// silently vanish — a payment with a lost receipt is still a payment.
		Naulon_Ledger::record( $this->settlement( array( 'settlement_ref' => '' ) ) );
		Naulon_Ledger::record( $this->settlement( array( 'settlement_ref' => '' ) ) );

		$this->assertSame( 6000, Naulon_Ledger::total_for_wallet( self::AUTHOR_WALLET ) );
		$this->assertSame( 2, Naulon_Ledger::settlement_count() );
	}

	// ── Refusing to record nonsense ──────────────────────────────────────────────────────────

	public function test_a_leg_with_an_unreadable_amount_is_skipped_rather_than_stored_as_zero() {
		// A zero row reads as "this author earned nothing", which is a claim. Storing nothing is
		// the honest outcome of not being able to read the number.
		$written = Naulon_Ledger::record( $this->settlement( array( 'legs' => $this->legs( '0.003', '' ) ) ) );

		$this->assertSame( 0, $written );
		$this->assertSame( 0, Naulon_Ledger::site_total( '' ) );
	}

	public function test_a_leg_paying_the_burn_address_is_never_recorded() {
		$legs = $this->legs( '3000', '' );
		$legs[0]['requirements']['payTo'] = '0x0000000000000000000000000000000000000000';

		$this->assertSame( 0, Naulon_Ledger::record( $this->settlement( array( 'legs' => $legs ) ) ) );
	}

	public function test_a_settlement_with_no_legs_writes_nothing() {
		$this->assertSame( 0, Naulon_Ledger::record( $this->settlement( array( 'legs' => array() ) ) ) );
	}

	// ── Reading it back ──────────────────────────────────────────────────────────────────────

	public function test_per_wallet_totals_split_settled_from_authorized() {
		Naulon_Ledger::record( $this->settlement() );
		Naulon_Ledger::record( $this->settlement( array( 'settlement_ref' => '0xref2' ) ) );

		$totals = array();
		foreach ( Naulon_Ledger::totals_by_wallet() as $row ) {
			$totals[ $row['pay_to'] ] = $row;
		}

		$this->assertSame( '6000', $totals[ strtolower( self::AUTHOR_WALLET ) ]['settled'] );
		$this->assertSame( '0', $totals[ strtolower( self::AUTHOR_WALLET ) ]['pending'] );
		$this->assertSame( '4000', $totals[ strtolower( self::COAUTHOR_WALLET ) ]['pending'] );
	}

	public function test_one_payees_recent_rows_never_include_another_payees() {
		Naulon_Ledger::record( $this->settlement() );

		$rows = Naulon_Ledger::recent( 10, self::COAUTHOR_WALLET );
		$this->assertCount( 1, $rows );
		$this->assertSame( strtolower( self::COAUTHOR_WALLET ), $rows[0]['pay_to'] );
	}

	public function test_a_wallet_is_matched_whatever_case_it_was_typed_in() {
		// Addresses are often pasted checksummed (mixed case). An author whose earnings appeared
		// as zero because of capitalisation would reasonably conclude they had not been paid.
		Naulon_Ledger::record( $this->settlement() );

		$shouted = '0x' . strtoupper( substr( self::AUTHOR_WALLET, 2 ) );
		$this->assertSame( 3000, Naulon_Ledger::total_for_wallet( $shouted ) );
	}

	public function test_an_invalid_wallet_reads_nothing_rather_than_everything() {
		// The author view passes a wallet to scope the query. If a malformed one fell through to
		// the unscoped branch, an author with a broken address would be shown the whole site's
		// payments.
		Naulon_Ledger::record( $this->settlement() );

		$this->assertSame( 0, Naulon_Ledger::total_for_wallet( 'not-a-wallet' ) );
		$this->assertSame( array(), Naulon_Ledger::recent( 10, 'not-a-wallet' ) );
	}
}
