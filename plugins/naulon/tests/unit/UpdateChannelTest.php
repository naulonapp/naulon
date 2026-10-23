<?php
/**
 * The plugin is distributed through the wordpress.org Plugin Directory, and Plugin Guideline 8
 * forbids a hosted plugin "serving updates or otherwise installing plugins, themes, or add-ons
 * from servers other than WordPress.org's". The directory already gives every install the update
 * notice, the one-click update and the auto-update toggle.
 *
 * So the plugin must declare no `Update URI` and define nothing a self-hosted update filter would
 * be registered against. Either would route update checks away from the directory, and a reviewer
 * or the automated scanners would close the listing for it.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class UpdateChannelTest extends TestCase {

	private function plugin_file_contents() {
		return file_get_contents( dirname( dirname( __DIR__ ) ) . '/naulon.php' );
	}

	public function test_the_plugin_does_not_serve_its_own_updates() {
		$php = $this->plugin_file_contents();

		$this->assertSame(
			0,
			preg_match( '/^\s*\*\s*Update URI:/m', $php ),
			'the plugin declares an Update URI; wordpress.org Guideline 8 forbids a hosted plugin serving its own updates'
		);
		$this->assertSame(
			0,
			preg_match( "/define\\(\\s*'NAULON_UPDATE_URI'/", $php ),
			'NAULON_UPDATE_URI is defined; an update filter would be registered against it'
		);
		$this->assertStringNotContainsString(
			'Naulon_Updater',
			$php,
			'the plugin loads or registers a self-updater'
		);
	}
}
