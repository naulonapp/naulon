<?php
/**
 * The plugin version is written in three places and WordPress reads two of them: the header
 * `Version:` (what the Plugins screen and the upload-overwrite comparison show) and readme.txt's
 * `Stable tag:` (what an update check reads). `NAULON_VERSION` is what our own code reports.
 *
 * They drifted silently once: two releases of behaviour changes shipped while all three still
 * said 0.1.0, so WordPress's own "Current / Uploaded" table showed a publisher 0.1.0 replacing
 * 0.1.0 — no way to tell a fixed build from a broken one, and no update ever offered. This test
 * does not know what the version SHOULD be; it only refuses to let the three disagree.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class VersionTest extends TestCase {

	private function plugin_dir() {
		return dirname( dirname( __DIR__ ) );
	}

	private function match( $file, $pattern ) {
		$contents = file_get_contents( $this->plugin_dir() . '/' . $file );
		$this->assertNotFalse( $contents, "could not read {$file}" );
		$this->assertSame( 1, preg_match( $pattern, $contents, $m ), "no version found in {$file}" );
		return $m[1];
	}

	public function test_header_constant_and_stable_tag_agree() {
		$header   = $this->match( 'naulon.php', '/^\s*\*\s*Version:\s*(\S+)/m' );
		$constant = $this->match( 'naulon.php', "/define\(\s*'NAULON_VERSION',\s*'([^']+)'/" );
		$stable   = $this->match( 'readme.txt', '/^Stable tag:\s*(\S+)/m' );

		$this->assertSame( $header, $constant, 'plugin header Version and NAULON_VERSION disagree' );
		$this->assertSame( $header, $stable, 'plugin header Version and readme.txt Stable tag disagree' );
	}

	/**
	 * The display name is written twice and Plugin Check compares them: `Plugin Name:` in the
	 * header and readme.txt's first line. A mismatch is reported as one plugin claiming two
	 * names, which costs a review round.
	 *
	 * The two halves sit on opposite sides of the writing-voice em-dash ban -- readme.txt is a
	 * published-prose plane and the PHP header is not -- so a de-slop pass over one of them
	 * silently broke the pair once. Nothing but this test reads both.
	 */
	/**
	 * An Upgrade Notice is what the Plugins screen shows a site before it takes an update, so a
	 * release without one asks every publisher to install a change sight unseen.
	 *
	 * release.yml used to assert this, inside a manifest checker that was retired with the
	 * self-updater. Asking it here runs it on every push instead of only at a tag, which is
	 * where the original incident said the question belongs: before the irreversible step.
	 */
	public function test_the_shipping_version_has_an_upgrade_notice() {
		$version = $this->match( 'naulon.php', '/^\s*\*\s*Version:\s*(\S+)/m' );
		$readme  = file_get_contents( $this->plugin_dir() . '/readme.txt' );
		$notices = strstr( $readme, '== Upgrade Notice ==' );

		$this->assertNotFalse( $notices, 'readme.txt has no Upgrade Notice section' );
		$this->assertStringContainsString(
			"= {$version} =",
			$notices,
			"readme.txt has no Upgrade Notice for {$version} — the Plugins screen would offer the update with nothing to read"
		);
	}

	public function test_the_display_name_is_spelled_the_same_in_both_places() {
		$header = $this->match( 'naulon.php', '/^\s*\*\s*Plugin Name:\s*(.+?)\s*$/m' );
		$readme = $this->match( 'readme.txt', '/^===\s*(.+?)\s*===/m' );

		$this->assertSame(
			$header,
			$readme,
			'the plugin header display name and readme.txt\'s first line disagree'
		);
	}

	/**
	 * wordpress.org requires the text domain to equal the slug, and translate.wordpress.org
	 * serves nothing when they differ. The slug is `naulon`.
	 */
	public function test_the_text_domain_equals_the_slug() {
		$this->assertSame(
			'naulon',
			$this->match( 'naulon.php', '/^\s*\*\s*Text Domain:\s*(\S+)/m' ),
			'the Text Domain header is not the slug wordpress.org allocated'
		);
	}

	public function test_the_changelog_documents_the_shipping_version() {
		$version = $this->match( 'naulon.php', '/^\s*\*\s*Version:\s*(\S+)/m' );
		$readme  = file_get_contents( $this->plugin_dir() . '/readme.txt' );

		$this->assertStringContainsString(
			"= {$version} =",
			$readme,
			"readme.txt has no changelog entry for {$version} — a release with no note is a release nobody can assess"
		);
	}
}
