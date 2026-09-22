<?php
/**
 * The two places the plugin turned machine values into words, and why each exists.
 *
 * Both were found by driving the admin as a publisher: the decoded 402 told a site owner their
 * authors were paid on chain "eip155:5042", and the People screen answered "who may do what"
 * with `naulon_manage_settings`. Neither is a string anybody outside this codebase can act on.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class LabelsTest extends TestCase {

	public function test_a_chain_id_becomes_the_name_the_rest_of_naulon_uses() {
		$this->assertSame( 'Arc', Naulon_Ledger::network_name( 'eip155:5042' ) );
		$this->assertSame( 'Arc testnet', Naulon_Ledger::network_name( 'eip155:5042002' ) );
		$this->assertSame( 'Base', Naulon_Ledger::network_name( 'eip155:8453' ) );
	}

	/**
	 * A chain we have not mapped yet must still print something true. Degrading to the id is
	 * worse than a name and far better than an empty cell on the screen a publisher uses to
	 * decide whether to trust the toll.
	 */
	public function test_an_unmapped_chain_degrades_to_its_id_not_to_nothing() {
		$this->assertSame( 'eip155:31337', Naulon_Ledger::network_name( 'eip155:31337' ) );
		$this->assertSame( '', Naulon_Ledger::network_name( '' ) );
	}

	public function test_a_leg_role_says_whose_money_it_is() {
		$this->assertSame( 'author', Naulon_Ledger::role_label( 'author' ) );
		$this->assertSame( 'naulon fee', Naulon_Ledger::role_label( 'operator' ) );
		$this->assertSame( 'naulon fee', Naulon_Ledger::role_label( 'OPERATOR' ) );
	}

	/**
	 * An unlabelled row renders without a label rather than with the word "unknown" beside
	 * somebody's payout.
	 */
	public function test_an_empty_role_produces_no_label() {
		$this->assertSame( '', Naulon_Ledger::role_label( '' ) );
		$this->assertSame( 'coauthor', Naulon_Ledger::role_label( 'coauthor' ) );
	}

	public function test_every_capability_the_plugin_grants_has_a_sentence() {
		$labels = Naulon_Roles::labels();
		foreach ( Naulon_Roles::map() as $caps ) {
			foreach ( $caps as $cap ) {
				$this->assertArrayHasKey( $cap, $labels, "capability {$cap} is granted to a role but has no sentence — the People screen would print the slug" );
				$this->assertNotSame( $cap, $labels[ $cap ] );
			}
		}
	}

	public function test_a_capability_added_by_a_filter_falls_back_to_its_slug() {
		$this->assertSame( 'some_other_cap', Naulon_Roles::label( 'some_other_cap' ) );
	}
}
