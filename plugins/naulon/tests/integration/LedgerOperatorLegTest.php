<?php
/**
 * The operator leg is naulon's commission, and it is not this site's income.
 *
 * It is recorded like any other leg, because the buyer really did pay it and a ledger missing a
 * leg cannot be reconciled against the chain. But every publisher-facing total read it as money
 * the site had been paid: the header on all five admin screens said PAID OUT 0.033000 USDC for a
 * read whose author was paid 0.030000, and the per-author table listed our own fee wallet as a
 * payee row labelled "not a user on this site".
 *
 * The predicate is `role <> 'operator'`, not `role = 'author'`, for two reasons this file exists
 * to hold: a co-author leg must keep counting, and rows written before the fee existed carry an
 * empty role and were all author legs.
 *
 * @package naulon
 */

class LedgerOperatorLegTest extends WP_UnitTestCase {

	const AUTHOR   = '0x1111111111111111111111111111111111111111';
	const COAUTHOR = '0x2222222222222222222222222222222222222222';
	const OPERATOR = '0xc0c1be21dc23d1d4a402ca04d938f0b2c42cbf8e';

	/**
	 * @param string $ref Settlement reference.
	 * @return array
	 */
	private function settlement( $ref = '0xref-op' ) {
		return array(
			'post_id'        => 0,
			'slug'           => 'articles/hello',
			'kind'           => 'read',
			'settlement_ref' => $ref,
			'payer'          => '0x9999999999999999999999999999999999999999',
			'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
			'legs'           => array(
				array(
					'role'         => 'author',
					'requirements' => array( 'payTo' => self::AUTHOR, 'amount' => '30000', 'network' => 'eip155:5042' ),
				),
				array(
					'role'         => 'operator',
					'requirements' => array( 'payTo' => self::OPERATOR, 'amount' => '3000', 'network' => 'eip155:5042' ),
				),
			),
		);
	}

	public function test_the_site_total_is_what_the_people_here_were_paid_not_what_the_agent_spent() {
		Naulon_Ledger::record( $this->settlement() );

		// The author leg settles synchronously; the operator leg is authorized and drained after.
		$this->assertSame( 30000, Naulon_Ledger::site_total( Naulon_Ledger::STATUS_SETTLED ) );
		$this->assertSame( 0, Naulon_Ledger::site_total( Naulon_Ledger::STATUS_PENDING ) );
		$this->assertSame( 30000, Naulon_Ledger::site_total( '' ) );
	}

	public function test_the_fee_is_readable_on_its_own_rather_than_hidden() {
		Naulon_Ledger::record( $this->settlement() );

		$this->assertSame( 3000, Naulon_Ledger::operator_total( '' ) );
	}

	public function test_the_fee_wallet_is_not_listed_among_this_sites_authors() {
		Naulon_Ledger::record( $this->settlement() );

		$wallets = wp_list_pluck( Naulon_Ledger::totals_by_wallet( 50 ), 'pay_to' );
		$this->assertContains( strtolower( self::AUTHOR ), $wallets );
		$this->assertNotContains( strtolower( self::OPERATOR ), $wallets );
	}

	public function test_a_co_authors_share_still_counts_as_money_this_site_earned() {
		Naulon_Ledger::record(
			array(
				'post_id'        => 0,
				'slug'           => 'articles/two-writers',
				'kind'           => 'read',
				'settlement_ref' => '0xref-co',
				'payer'          => '0x9999999999999999999999999999999999999999',
				'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
				'legs'           => array(
					array(
						'role'         => 'author',
						'requirements' => array( 'payTo' => self::AUTHOR, 'amount' => '2000', 'network' => 'eip155:5042' ),
					),
					array(
						'role'         => 'coauthor',
						'requirements' => array( 'payTo' => self::COAUTHOR, 'amount' => '1000', 'network' => 'eip155:5042' ),
					),
					array(
						'role'         => 'operator',
						'requirements' => array( 'payTo' => self::OPERATOR, 'amount' => '300', 'network' => 'eip155:5042' ),
					),
				),
			)
		);

		$this->assertSame( 3000, Naulon_Ledger::site_total( '' ), 'a co-author leg is this site earning money and must survive the filter' );
		$this->assertContains( strtolower( self::COAUTHOR ), wp_list_pluck( Naulon_Ledger::totals_by_wallet( 50 ), 'pay_to' ) );
	}

	/**
	 * Rows written before the operator fee existed carry an empty role. Dropping them would
	 * silently delete history from a money screen, which is the failure this filter must not
	 * cause while fixing the other one.
	 */
	public function test_a_leg_recorded_before_roles_existed_still_counts() {
		global $wpdb;
		$wpdb->query(
			$wpdb->prepare(
				'INSERT INTO %i (settled_at, post_id, slug, kind, settlement_ref, leg_index, role, pay_to, amount_atomic, network, payer, status)
				 VALUES (%s,%d,%s,%s,%s,%d,%s,%s,%d,%s,%s,%s)',
				Naulon_Ledger::table(),
				current_time( 'mysql', true ),
				0,
				'articles/legacy',
				'read',
				'0xref-legacy',
				0,
				'',
				strtolower( self::AUTHOR ),
				5000,
				'eip155:84532',
				'0x9999999999999999999999999999999999999999',
				Naulon_Ledger::STATUS_SETTLED
			)
		);

		$this->assertSame( 5000, Naulon_Ledger::site_total( Naulon_Ledger::STATUS_SETTLED ) );
	}
}
