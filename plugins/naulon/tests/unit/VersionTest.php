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
