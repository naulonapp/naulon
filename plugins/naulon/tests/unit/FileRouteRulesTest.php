<?php
/**
 * The rewrite rules that route opted-in uploads into the toll, and the nginx rule a site without
 * `.htaccess` pastes instead.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class FileRouteRulesTest extends TestCase {

	const PLUGIN = '/var/www/html/wp-content/plugins/naulon/naulon.php';

	public function test_rules_route_opted_types_and_the_probe_behind_the_plugin_file_guard() {
		$this->assertSame(
			array(
				'<IfModule mod_rewrite.c>',
				'RewriteEngine On',
				'RewriteCond "/var/www/html/wp-content/plugins/naulon/naulon.php" -f',
				'RewriteRule ^wp-content/uploads/(naulon-probe/.+|.+\.(pdf|xml))$ /index.php?naulon_file=$1 [L,QSA]',
				'</IfModule>',
			),
			Naulon_File_Route::rules_for( array( 'pdf', 'xml' ), self::PLUGIN, 'wp-content/uploads', '/' )
		);
	}

	public function test_no_types_routes_only_the_probe() {
		$rules = Naulon_File_Route::rules_for( array(), self::PLUGIN, 'wp-content/uploads', '/' );
		$this->assertSame( 'RewriteRule ^wp-content/uploads/(naulon-probe/.+)$ /index.php?naulon_file=$1 [L,QSA]', $rules[3] );
	}

	public function test_unknown_types_are_dropped() {
		$rules = Naulon_File_Route::rules_for( array( 'pdf', 'php', 'exe' ), self::PLUGIN, 'wp-content/uploads', '/' );
		$this->assertStringContainsString( '\.(pdf))$', $rules[3] );
		$this->assertStringNotContainsString( '|php', $rules[3] );
		$this->assertStringNotContainsString( 'exe', $rules[3] );
	}

	public function test_a_subdirectory_install_targets_its_own_index() {
		$rules = Naulon_File_Route::rules_for( array( 'pdf' ), self::PLUGIN, 'content/uploads', '/blog/' );
		$this->assertSame( 'RewriteRule ^content/uploads/(naulon-probe/.+|.+\.(pdf))$ /blog/index.php?naulon_file=$1 [L,QSA]', $rules[3] );
	}

	public function test_uploads_path_is_regex_quoted() {
		$rules = Naulon_File_Route::rules_for( array( 'pdf' ), self::PLUGIN, 'wp-content/up.loads', '/' );
		$this->assertStringContainsString( '^wp-content/up\.loads/', $rules[3] );
	}

	public function test_nginx_snippet_names_the_route_and_warns_about_removal() {
		$snippet = Naulon_File_Route::nginx_snippet( array( 'pdf' ), '/wp-content/uploads/', '/' );
		$this->assertStringContainsString( 'location ~* ^/wp-content/uploads/(naulon-probe/.+|.+\.(pdf))$', $snippet );
		$this->assertStringContainsString( '/index.php?naulon_file=$1&$args', $snippet );
		$this->assertStringContainsString( 'Remove this block if you remove the naulon plugin', $snippet );
	}
}
