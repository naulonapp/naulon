<?php
/**
 * The marker block in the real `.htaccess`: written on activation, rewritten when the opted-in set
 * changes, gone on deactivation, and never written where it cannot work.
 *
 * @package naulon
 */

class FileRouteWriteTest extends WP_UnitTestCase {

	/** @var string */
	private $htaccess;

	/** @var string|null */
	private $original;

	public function set_up() {
		parent::set_up();
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$this->htaccess = get_home_path() . '.htaccess';
		$this->original = file_exists( $this->htaccess ) ? file_get_contents( $this->htaccess ) : null; // phpcs:ignore
		file_put_contents( $this->htaccess, "# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n" ); // phpcs:ignore
		add_filter( 'got_rewrite', '__return_true' );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'pdf' ) );
	}

	public function tear_down() {
		remove_filter( 'got_rewrite', '__return_true' );
		delete_option( Naulon_Rules::FILE_TYPES_OPTION );
		if ( null === $this->original ) {
			unlink( $this->htaccess ); // phpcs:ignore
		} else {
			file_put_contents( $this->htaccess, $this->original ); // phpcs:ignore
		}
		parent::tear_down();
	}

	private function block() {
		return implode( "\n", extract_from_markers( $this->htaccess, Naulon_File_Route::MARKER ) );
	}

	public function test_sync_writes_the_guarded_block_beside_wordpress() {
		$this->assertTrue( Naulon_File_Route::instance()->sync() );

		$this->assertStringContainsString( 'RewriteCond "' . NAULON_PLUGIN_FILE . '" -f', $this->block() );
		$this->assertStringContainsString( '.+\.(pdf))$ /index.php?naulon_file=$1 [L,QSA]', $this->block() );
		$this->assertStringContainsString( '# BEGIN WordPress', file_get_contents( $this->htaccess ) ); // phpcs:ignore
	}

	public function test_a_changed_set_rewrites_the_block() {
		Naulon_File_Route::instance()->sync();
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'json', 'pdf' ) );
		do_action( 'naulon_file_types_changed', array( 'json', 'pdf' ), array( 'pdf' ) );

		$this->assertStringContainsString( '\.(json|pdf))$', $this->block() );
		$this->assertSame( 1, substr_count( file_get_contents( $this->htaccess ), '# BEGIN naulon-files' ) ); // phpcs:ignore
	}

	public function test_remove_leaves_no_rule() {
		Naulon_File_Route::instance()->sync();
		Naulon_File_Route::instance()->remove();

		$this->assertSame( '', $this->block() );
		$this->assertStringNotContainsString( 'naulon_file', file_get_contents( $this->htaccess ) ); // phpcs:ignore
	}

	public function test_deactivation_removes_the_block() {
		Naulon_File_Route::instance()->sync();
		naulon_deactivate();

		$this->assertStringNotContainsString( 'naulon_file', file_get_contents( $this->htaccess ) ); // phpcs:ignore
	}

	public function test_no_mod_rewrite_writes_nothing() {
		remove_filter( 'got_rewrite', '__return_true' );
		add_filter( 'got_rewrite', '__return_false' );

		$this->assertFalse( Naulon_File_Route::instance()->sync() );
		$this->assertStringNotContainsString( 'naulon_file', file_get_contents( $this->htaccess ) ); // phpcs:ignore
		remove_filter( 'got_rewrite', '__return_false' );
	}

	public function test_offloaded_uploads_write_nothing() {
		$offload = function ( $dirs ) {
			$dirs['baseurl'] = 'https://media.example.net/uploads';
			return $dirs;
		};
		add_filter( 'upload_dir', $offload );

		$this->assertNull( Naulon_File_Route::uploads_rel() );
		$this->assertFalse( Naulon_File_Route::instance()->sync() );
		remove_filter( 'upload_dir', $offload );
	}
}
