<?php
/**
 * "Deleting the plugin does not destroy your data unless you asked for it" has to be a property of
 * the code, not a sentence in a docblock. These tests are what makes it one.
 *
 * The failure being guarded against is specific and already happened: WordPress runs
 * `uninstall_plugin()` BEFORE `$wp_filesystem->delete()` (`wp-admin/includes/plugin.php`), so on a
 * site whose plugin directory was owned by root the file removal failed — the plugin stayed listed
 * as installed — while the wallets and the earnings table were already gone. One click, no undo,
 * and no visible sign it had done anything.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class UninstallGuardTest extends TestCase {

	private function uninstall_source() {
		return file_get_contents( dirname( dirname( __DIR__ ) ) . '/uninstall.php' );
	}

	/**
	 * Absent, empty, null, 0, "1" — none of those are consent. Only a real boolean true, because
	 * the value is written by a checkbox handler and read on a path that drops a database table.
	 *
	 * @dataProvider provide_non_consent
	 */
	public function test_only_an_explicit_true_authorises_removal( $settings ) {
		$this->assertFalse( Naulon_Data::should_purge( $settings ) );
	}

	public static function provide_non_consent() {
		return array(
			'absent'          => array( array() ),
			'false'           => array( array( 'purge_on_uninstall' => false ) ),
			'null'            => array( array( 'purge_on_uninstall' => null ) ),
			'zero'            => array( array( 'purge_on_uninstall' => 0 ) ),
			'empty string'    => array( array( 'purge_on_uninstall' => '' ) ),
			'string one'      => array( array( 'purge_on_uninstall' => '1' ) ),
			'string true'     => array( array( 'purge_on_uninstall' => 'true' ) ),
			'truthy but not'  => array( array( 'purge_on_uninstall' => 'yes' ) ),
		);
	}

	public function test_an_explicit_true_authorises_removal() {
		$this->assertTrue( Naulon_Data::should_purge( array( 'purge_on_uninstall' => true ) ) );
	}

	/**
	 * The default in the settings array IS the promise. If it ever flips, every future delete
	 * destroys data again with nobody having chosen that.
	 */
	public function test_the_shipped_default_keeps_data() {
		$defaults = file_get_contents( dirname( dirname( __DIR__ ) ) . '/includes/class-naulon-settings.php' );

		$this->assertSame(
			1,
			preg_match( "/'purge_on_uninstall'\s*=>\s*(\w+)/", $defaults, $m ),
			'the purge setting has no default at all'
		);
		$this->assertSame( 'false', $m[1], 'the shipped default must keep a publisher\'s data' );
	}

	/**
	 * `uninstall.php` must stay a delegation. A destructive call added directly to that file would
	 * bypass the opt-in entirely, and would read as perfectly ordinary code while doing it — this
	 * is the only place that can notice.
	 *
	 * @dataProvider provide_destructive_calls
	 */
	public function test_uninstall_php_destroys_nothing_itself( $needle ) {
		$this->assertStringNotContainsString(
			$needle,
			$this->uninstall_source(),
			"uninstall.php calls {$needle} directly — every destructive path must go through Naulon_Data::uninstall() so the opt-in cannot be bypassed"
		);
	}

	public static function provide_destructive_calls() {
		return array(
			'drop the ledger'    => array( 'Ledger::drop' ),
			'delete user meta'   => array( 'delete_metadata' ),
			'delete post meta'   => array( 'delete_post_meta_by_key' ),
			'delete the option'  => array( 'delete_all' ),
			'remove caps'        => array( 'remove_capabilities' ),
			'clear the log'      => array( 'Log::clear' ),
			'raw option delete'  => array( 'delete_option' ),
			'raw table drop'     => array( 'DROP TABLE' ),
		);
	}

	public function test_uninstall_php_delegates_to_the_guarded_entry_point() {
		$this->assertStringContainsString( 'Naulon_Data::uninstall()', $this->uninstall_source() );
	}

	/**
	 * The export is a file that travels — a downloads folder, an email, a support ticket. A key
	 * that can quote and settle has no business in one, and it costs seconds to re-paste.
	 */
	public function test_the_export_field_list_excludes_the_api_key() {
		$source = file_get_contents( dirname( dirname( __DIR__ ) ) . '/includes/class-naulon-data.php' );

		$this->assertSame( 1, preg_match( '/\$keep\s*=\s*array\(([^)]*)\)/', $source, $m ) );
		$this->assertStringNotContainsString( "'api_key'", $m[1] );
		$this->assertStringContainsString( "'api_base'", $m[1] );
	}
}
