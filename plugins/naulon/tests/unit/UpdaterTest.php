<?php
/**
 * The update path decides which zip a publisher's server downloads, unpacks and executes. Every
 * test here is about one of the three ways that goes wrong: trusting a manifest it should have
 * rejected, being silently routed to a filter nobody listens on so no update ever appears, or
 * telling a publisher their site is untested when it is not.
 *
 * The mapping functions are pure by design (see the class docblock) so this suite needs no
 * WordPress. The HTTP fetch and the transient caching are covered by UpdaterCacheTest, in the
 * wp-env suite, because caching is WordPress.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class UpdaterTest extends TestCase {

	private function manifest( array $overrides = array() ) {
		return array_merge(
			array(
				'name'           => 'naulon — citation toll',
				'slug'           => 'naulon',
				'version'        => '0.9.1',
				'url'            => 'https://naulon.app/wp/naulon',
				'homepage'       => 'https://naulon.app',
				'requires'       => '6.2',
				'requires_php'   => '7.4',
				'tested'         => '7.0',
				'package'        => 'https://github.com/naulonapp/naulon/releases/latest/download/naulon.zip',
				'upgrade_notice' => 'Worth taking.',
				'sections'       => array( 'changelog' => '<h4>0.9.1</h4>' ),
			),
			$overrides
		);
	}

	private function plugin_file_contents() {
		return file_get_contents( dirname( dirname( __DIR__ ) ) . '/naulon.php' );
	}

	/**
	 * The one thing core insists on. `wp-includes/update.php` skips any filter result without a
	 * `version` — "is it valid? we require at least a version" — so an otherwise perfect payload
	 * missing this key is a plugin that can never be updated, with nothing anywhere saying why.
	 */
	public function test_payload_carries_the_version_core_requires() {
		$payload = Naulon_Updater::payload( $this->manifest(), 'naulon/naulon.php', '7.0.2' );

		$this->assertSame( '0.9.1', $payload['version'] );
		$this->assertSame( 'naulon', $payload['slug'] );
		$this->assertSame( 'naulon/naulon.php', $payload['plugin'] );
	}

	/**
	 * The auto-update toggle exists only for plugins core knows an update source for, and core
	 * learns that from the payload being filed under `no_update` when the version already matches
	 * (`WP_Plugins_List_Table::prepare_items`, the response/no_update/else chain). So the mapping
	 * must not depend on the version being newer — returning nothing when up to date is exactly
	 * how a self-hosted plugin ends up updatable by hand but never automatically.
	 */
	public function test_payload_is_built_regardless_of_whether_the_version_is_newer() {
		$older = Naulon_Updater::payload( $this->manifest( array( 'version' => '0.0.1' ) ), 'naulon/naulon.php', '7.0.2' );

		$this->assertSame( '0.0.1', $older['version'] );
		$this->assertArrayHasKey( 'package', $older );
	}

	public function test_payload_passes_through_the_compatibility_fields_core_warns_from() {
		$payload = Naulon_Updater::payload( $this->manifest(), 'naulon/naulon.php', '7.0.2' );

		$this->assertSame( '6.2', $payload['requires'] );
		$this->assertSame( '7.4', $payload['requires_php'] );
		$this->assertSame( 'Worth taking.', $payload['upgrade_notice'] );
	}

	public function test_payload_omits_fields_the_manifest_left_empty() {
		$payload = Naulon_Updater::payload(
			$this->manifest(
				array(
					'tested'         => '',
					'upgrade_notice' => '',
				)
			),
			'naulon/naulon.php',
			'7.0.2'
		);

		$this->assertArrayNotHasKey( 'tested', $payload );
		$this->assertArrayNotHasKey( 'upgrade_notice', $payload );
	}

	public function test_a_well_formed_manifest_validates() {
		$this->assertNotNull( Naulon_Updater::validate( $this->manifest() ) );
	}

	/**
	 * The package URL is code about to be executed on a publisher's server. A manifest that could
	 * name any host would make one hijacked JSON file remote code execution on every install, so
	 * the host is pinned in the plugin and a manifest that disagrees is rejected whole.
	 *
	 * The lookalike cases are the point: a substring test would pass all three.
	 *
	 * @dataProvider foreign_packages
	 */
	public function test_a_package_off_the_release_host_is_refused( $package ) {
		$this->assertNull( Naulon_Updater::validate( $this->manifest( array( 'package' => $package ) ) ) );
	}

	public static function foreign_packages() {
		return array(
			'another host entirely'   => array( 'https://evil.example/naulon.zip' ),
			'host as a prefix'        => array( 'https://github.com.evil.example/naulonapp/naulon/releases/x.zip' ),
			'host in the path'        => array( 'https://evil.example/https://github.com/naulonapp/naulon/releases/x.zip' ),
			'another repo, same host' => array( 'https://github.com/someone/else/releases/latest/download/naulon.zip' ),
			'plain http'              => array( 'http://github.com/naulonapp/naulon/releases/latest/download/naulon.zip' ),
			'missing'                 => array( '' ),
		);
	}

	/**
	 * `version_compare` does not fail on garbage, it decides something. A version it cannot
	 * meaningfully compare must be refused before it reaches that decision.
	 *
	 * @dataProvider uncomparable_versions
	 */
	public function test_a_version_core_cannot_compare_is_refused( $version ) {
		$this->assertNull( Naulon_Updater::validate( $this->manifest( array( 'version' => $version ) ) ) );
	}

	public static function uncomparable_versions() {
		return array(
			'empty'    => array( '' ),
			'words'    => array( 'latest' ),
			'v prefix' => array( 'v1.2.3' ),
			'markup'   => array( '1.2.3<script>' ),
			'spaces'   => array( '1.2 .3' ),
		);
	}

	public function test_a_manifest_for_a_different_plugin_is_refused() {
		$this->assertNull( Naulon_Updater::validate( $this->manifest( array( 'slug' => 'not-naulon' ) ) ) );
	}

	/**
	 * The manifest is fetched from the release host and may only point at the release host. If
	 * those two ever diverged, every manifest we publish would fail our own validation and the
	 * result would look exactly like "no update available".
	 */
	public function test_the_manifest_and_the_package_share_the_pinned_host() {
		$this->assertStringStartsWith( Naulon_Updater::PACKAGE_PREFIX, Naulon_Updater::MANIFEST_URL );
	}

	/**
	 * A readme's `Tested up to` is a WordPress BRANCH; core compares it against the full running
	 * version. Left alone, that means the details modal warns "has not been tested with your
	 * current version" on every WordPress patch release — a false alarm about the one field whose
	 * job is real alarms. wordpress.org normalises the branch for hosted plugins; nothing does it
	 * for a self-hosted one.
	 *
	 * @dataProvider provide_tested_branches
	 */
	public function test_a_tested_branch_is_widened_only_within_that_branch( $tested, $wp, $expected ) {
		$this->assertSame( $expected, Naulon_Updater::tested_for( $tested, $wp ) );
	}

	// NOT named `tested_…`: PHPUnit collects every public method whose name starts with "test" as a
	// test, so a provider called `tested_cases` runs as a test of its own and is reported risky for
	// asserting nothing.
	public static function provide_tested_branches() {
		return array(
			'patch of the tested branch'   => array( '7.0', '7.0.2', '7.0.2' ),
			'exactly the tested branch'    => array( '7.0', '7.0', '7.0' ),
			'a LATER branch still warns'   => array( '7.0', '7.1', '7.0' ),
			'a later branch with a patch'  => array( '7.0', '7.1.1', '7.0' ),
			'an earlier running version'   => array( '7.0', '6.9.5', '7.0' ),
			'already specific, untouched'  => array( '7.0.1', '7.0.2', '7.0.1' ),
			'a dev build of the branch'    => array( '7.0', '7.0.2-alpha-1', '7.0.2-alpha-1' ),
			'lookalike branch not widened' => array( '7.0', '7.01.2', '7.0' ),
			'empty stays empty'            => array( '', '7.0.2', '' ),
		);
	}

	public function test_payload_reports_tested_against_the_running_version() {
		$payload = Naulon_Updater::payload( $this->manifest(), 'naulon/naulon.php', '7.0.2' );

		$this->assertSame( '7.0.2', $payload['tested'] );
	}

	/**
	 * The inverse of the guard that used to live here. While this plugin was distributed only
	 * from GitHub it HAD to declare an `Update URI` and register a filter against it, and the
	 * test asserted the header and the constant could not drift apart.
	 *
	 * Listing on wordpress.org reverses that requirement into a prohibition. Plugin Guideline 8
	 * forbids "serving updates or otherwise installing plugins, themes, or add-ons from servers
	 * other than WordPress.org\'s", and the directory does the job the updater existed to do —
	 * update notice, one-click update, auto-update toggle — for every install, for free.
	 *
	 * So the shipped plugin must declare no `Update URI` and register no updater. The class
	 * itself stays in the repository (and is still covered by every test above) because the
	 * GitHub zip remains the only channel until the listing is live; `.distignore` keeps it out
	 * of the zip that goes to wordpress.org.
	 */
	public function test_the_plugin_does_not_serve_its_own_updates() {
		$php = $this->plugin_file_contents();

		$this->assertSame(
			0,
			preg_match( '/^\s*\*\s*Update URI:/m', $php ),
			'the plugin declares an Update URI — wordpress.org Guideline 8 forbids a hosted plugin serving its own updates'
		);
		$this->assertSame(
			0,
			preg_match( "/define\\(\\s*'NAULON_UPDATE_URI'/", $php ),
			'NAULON_UPDATE_URI is still defined — the update filter would be registered against it'
		);
		$this->assertStringNotContainsString(
			'Naulon_Updater',
			$php,
			'the plugin still loads or registers the self-updater'
		);
	}

	/**
	 * No banner, on purpose. Core prints the plugin's name over the banner in the details modal
	 * (`install_plugin_information()`), and our banner art already carries the wordmark — so sending
	 * one rendered the name twice, overlapping itself. The icon carries no such overlay. If a
	 * manifest starts offering banners again, this fails rather than quietly reintroducing it.
	 */
	public function test_no_banner_is_sent_while_the_art_duplicates_the_title() {
		$manifest = $this->manifest(
			array(
				'icons'   => array( '1x' => 'https://example.test/icon.png' ),
				'banners' => array( 'low' => 'https://example.test/banner.png' ),
			)
		);

		$payload = Naulon_Updater::payload( $manifest, 'naulon/naulon.php', '7.0.2' );
		$info    = Naulon_Updater::information( $manifest, '7.0.2' );

		$this->assertArrayNotHasKey( 'banners', $payload );
		$this->assertArrayNotHasKey( 'banners_rtl', $payload );
		$this->assertArrayNotHasKey( 'banners', $info );
		$this->assertSame( array( '1x' => 'https://example.test/icon.png' ), $payload['icons'] );
		$this->assertSame( array( '1x' => 'https://example.test/icon.png' ), $info['icons'] );
	}

	public function test_information_builds_the_modal_shape() {
		$info = Naulon_Updater::information( $this->manifest(), '7.0.2' );

		$this->assertSame( 'naulon', $info['slug'] );
		$this->assertSame( '0.9.1', $info['version'] );
		$this->assertSame( $this->manifest()['package'], $info['download_link'] );
		$this->assertSame( '<h4>0.9.1</h4>', $info['sections']['changelog'] );
		$this->assertSame( '7.0.2', $info['tested'] );
	}
}
