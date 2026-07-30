<?php
/**
 * Uninstall against a real database: the default keeps a publisher's data, the opt-in removes it,
 * and our own code artifacts go either way.
 *
 * UninstallGuardTest proves the decision function and proves `uninstall.php` cannot destroy
 * anything on its own. This proves the two outcomes actually happen — the part that needs wallets,
 * post meta and a ledger table to exist in order to mean anything.
 *
 * @package naulon
 */

class UninstallDataTest extends WP_UnitTestCase {

	/** @var int */
	private $author;

	public function set_up() {
		parent::set_up();

		Naulon_Ledger::maybe_install();

		$this->author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, '0x1111111111111111111111111111111111111111' );

		$post = self::factory()->post->create( array( 'post_author' => $this->author ) );
		update_post_meta( $post, Naulon_Credits::POST_TOLL_META, 'free' );

		Naulon_Settings::update( array( 'api_base' => 'https://gate.example', 'enforcement_on' => true ) );
	}

	private function wallet_rows() {
		global $wpdb;
		return (int) $wpdb->get_var(
			$wpdb->prepare( "SELECT COUNT(*) FROM {$wpdb->usermeta} WHERE meta_key = %s", Naulon_Credits::USER_WALLET_META )
		);
	}

	/**
	 * Whether the earnings table is still installed, observed through the ledger's own schema
	 * marker rather than `SHOW TABLES`.
	 *
	 * Not a shortcut — `SHOW TABLES` cannot answer this here. The WordPress test suite rewrites
	 * `CREATE TABLE` to `CREATE TEMPORARY TABLE` and `DROP TABLE` to `DROP TEMPORARY TABLE`
	 * (`tests/phpunit/includes/abstract-testcase.php`), and MySQL never lists temporary tables in
	 * `SHOW TABLES`. An assertion built on it would be measuring the harness. `drop()` deletes this
	 * option in the same breath as the table, so the option is the honest observable for "did the
	 * destructive path run".
	 *
	 * @return bool
	 */
	private function ledger_installed() {
		return false !== get_option( Naulon_Ledger::DB_VERSION_OPTION, false );
	}

	public function test_the_default_is_to_keep_everything() {
		$this->assertFalse( Naulon_Data::should_purge( Naulon_Settings::all() ), 'a fresh install must not be opted in' );

		$purged = Naulon_Data::uninstall();

		$this->assertFalse( $purged, 'uninstall reported a purge nobody asked for' );
		$this->assertSame( 1, $this->wallet_rows(), 'the author wallet was destroyed' );
		$this->assertTrue( $this->ledger_installed(), 'the earnings table was dropped' );
		$this->assertNotFalse( get_option( Naulon_Settings::OPTION ), 'the settings were destroyed' );
	}

	public function test_opting_in_removes_the_data() {
		Naulon_Settings::update( array( Naulon_Data::PURGE_SETTING => true ) );

		$purged = Naulon_Data::uninstall();

		$this->assertTrue( $purged );
		$this->assertSame( 0, $this->wallet_rows() );
		$this->assertFalse( $this->ledger_installed() );
		$this->assertFalse( get_option( Naulon_Settings::OPTION ) );
	}

	/**
	 * Our code goes regardless of the data policy. A must-use drop-in left executing on every
	 * request for a plugin that no longer exists is a bug, not a keepsake — and it is the one thing
	 * a publisher cannot see or remove from the admin once the plugin is gone.
	 */
	public function test_the_cache_guard_is_removed_even_when_data_is_kept() {
		$installed = Naulon_Cache::install_dropin();
		if ( empty( $installed['ok'] ) ) {
			$this->markTestSkipped( 'the mu-plugins directory is not writable in this environment' );
		}
		$this->assertFileExists( Naulon_Cache::dropin_path() );

		Naulon_Data::uninstall();

		$this->assertFileDoesNotExist( Naulon_Cache::dropin_path(), 'a drop-in survived for a deleted plugin' );
		$this->assertSame( 1, $this->wallet_rows(), 'removing our code must not touch their data' );
	}

	public function test_the_heartbeat_is_unscheduled_even_when_data_is_kept() {
		// `ensure_scheduled()` refuses on an unconnected site — an install with no key must not
		// phone home, which is a wordpress.org rule as well as the right default. So the
		// precondition for this test is a connected site, not just a call to the scheduler.
		Naulon_Settings::update( array( 'gate_url' => 'https://gate.example' ) );
		Naulon_Cron::instance()->ensure_scheduled();
		$this->assertNotFalse( wp_next_scheduled( Naulon_Cron::EVENT ) );

		Naulon_Data::uninstall();

		$this->assertFalse( wp_next_scheduled( Naulon_Cron::EVENT ), 'an event survived whose handler is gone' );
	}

	public function test_the_inventory_counts_what_deletion_would_destroy() {
		$inventory = Naulon_Data::inventory();

		$this->assertSame( 1, $inventory['wallets'] );
		$this->assertSame( 1, $inventory['tolled_posts'] );
		$this->assertArrayHasKey( 'settlements', $inventory );
		$this->assertArrayHasKey( 'settled_total', $inventory );
	}

	public function test_the_export_carries_the_wallets_and_never_the_key() {
		Naulon_Settings::update( array( 'api_key' => 'nln_live_secret_value' ) );

		$payload = Naulon_Data::export_payload();
		$encoded = wp_json_encode( $payload );

		$this->assertCount( 1, $payload['wallets'] );
		$this->assertSame( '0x1111111111111111111111111111111111111111', $payload['wallets'][0]['wallet'] );
		$this->assertArrayNotHasKey( 'api_key', $payload['settings'] );
		$this->assertStringNotContainsString( 'nln_live_secret_value', (string) $encoded, 'the API key leaked into an export file' );
	}
}
