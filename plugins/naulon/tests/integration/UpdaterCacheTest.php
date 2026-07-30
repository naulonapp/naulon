<?php
/**
 * The cached side of the update path — the half UpdaterTest cannot reach, because caching is
 * WordPress.
 *
 * The manifest is validated before it is stored, which is easy to mistake for "the stored copy is
 * trustworthy". It is not: a transient is a database row, and SQL injection in an unrelated plugin
 * or a restored backup can put anything in it. What the manifest names is a zip WordPress unpacks
 * and executes, so the validation has to run on every READ, and this is the test that says so. It
 * was written after a live run through core's real update path offered a planted package from a
 * lookalike host — the pinned-host check existed and simply was not on that path.
 *
 * @package naulon
 */

class UpdaterCacheTest extends WP_UnitTestCase {

	/** @var int How many outbound HTTP requests the code under test attempted. */
	private $requests = 0;

	public function set_up() {
		parent::set_up();

		delete_site_transient( Naulon_Updater::TRANSIENT );
		$this->requests = 0;

		// Every fetch is a fact to assert on rather than a real network call — with ONE exception
		// that is not politeness but necessity. `wp_update_plugins()` aborts outright when its own
		// api.wordpress.org call fails (`wp-includes/update.php`: `if ( is_wp_error( $raw_response )
		// || 200 !== … ) return;`) and the `Update URI` loop lives AFTER that return. Blocking that
		// call would mean this suite never reaches the code it is testing — and it is worth knowing
		// the same is true in production: a site that cannot reach wordpress.org gets no
		// self-hosted update check either, because core never gets that far.
		add_filter(
			'pre_http_request',
			function ( $preempt, $args, $url ) {
				if ( false !== strpos( (string) $url, 'api.wordpress.org' ) ) {
					return array(
						'headers'  => array(),
						'cookies'  => array(),
						'filename' => null,
						'response' => array(
							'code'    => 200,
							'message' => 'OK',
						),
						'body'     => wp_json_encode(
							array(
								'plugins'      => array(),
								'translations' => array(),
								'no_update'    => array(),
							)
						),
					);
				}

				++$this->requests;
				return new WP_Error( 'blocked', 'no network in tests' );
			},
			10,
			3
		);
	}

	public function tear_down() {
		delete_site_transient( Naulon_Updater::TRANSIENT );
		parent::tear_down();
	}

	private function manifest( array $overrides = array() ) {
		return array_merge(
			array(
				'name'         => 'naulon — citation toll',
				'slug'         => 'naulon',
				'version'      => '9.9.9',
				'url'          => 'https://naulon.app/wp/naulon',
				'requires'     => '6.2',
				'requires_php' => '7.4',
				'tested'       => '7.0',
				'package'      => 'https://github.com/naulonapp/naulon/releases/latest/download/naulon.zip',
				'sections'     => array( 'changelog' => '<h4>9.9.9</h4>' ),
			),
			$overrides
		);
	}

	private function offer() {
		return Naulon_Updater::instance()->offer( false, array(), plugin_basename( NAULON_PLUGIN_FILE ) );
	}

	public function test_a_valid_cached_manifest_is_served_without_a_request() {
		set_site_transient( Naulon_Updater::TRANSIENT, $this->manifest(), 600 );

		$offer = $this->offer();

		$this->assertIsArray( $offer );
		$this->assertSame( '9.9.9', $offer['version'] );
		$this->assertSame( 0, $this->requests, 'a cached manifest must not cost an HTTP request' );
	}

	/**
	 * The finding this test exists for. A cached manifest naming a package off the pinned release
	 * host must be refused, not served — and dropped, so the next check can fetch a real one
	 * instead of being stuck behind the poisoned row.
	 */
	public function test_a_poisoned_cached_manifest_is_refused_and_dropped() {
		set_site_transient(
			Naulon_Updater::TRANSIENT,
			$this->manifest( array( 'package' => 'https://github.com.evil.example/naulonapp/naulon/releases/x.zip' ) ),
			600
		);

		$this->assertFalse( $this->offer(), 'a package off the pinned host reached core' );
		$this->assertFalse( get_site_transient( Naulon_Updater::TRANSIENT ), 'the poisoned entry survived' );
	}

	public function test_a_cached_manifest_with_an_uncomparable_version_is_refused() {
		set_site_transient( Naulon_Updater::TRANSIENT, $this->manifest( array( 'version' => 'latest' ) ), 600 );

		$this->assertFalse( $this->offer() );
	}

	/**
	 * The negative cache. Without it, a release host that is down — or a site with no outbound
	 * network at all — makes a doomed request on every single update check.
	 */
	public function test_a_cached_failure_short_circuits_without_a_request() {
		set_site_transient( Naulon_Updater::TRANSIENT, Naulon_Updater::FAILURE, 600 );

		$this->assertFalse( $this->offer() );
		$this->assertSame( 0, $this->requests );
	}

	public function test_an_unreachable_host_is_remembered_as_a_failure() {
		$this->assertFalse( $this->offer() );

		$this->assertSame( 1, $this->requests );
		$this->assertSame( Naulon_Updater::FAILURE, get_site_transient( Naulon_Updater::TRANSIENT ) );
	}

	/**
	 * Another plugin could legitimately carry an `Update URI` on this host one day. Answering for
	 * a file that is not ours would hand it our zip.
	 */
	public function test_a_different_plugin_file_is_declined() {
		set_site_transient( Naulon_Updater::TRANSIENT, $this->manifest(), 600 );

		$this->assertFalse(
			Naulon_Updater::instance()->offer( false, array(), 'someone-else/plugin.php' )
		);
		$this->assertSame( 0, $this->requests );
	}

	/**
	 * The whole point, asserted through core's own code rather than ours: a newer version reaches
	 * `update_plugins->response` (the notice and the one-click update), and an equal version
	 * reaches `no_update` — which is what makes the auto-update toggle render at all.
	 */
	public function test_core_files_the_offer_where_the_plugins_screen_reads_it() {
		$file = plugin_basename( NAULON_PLUGIN_FILE );

		set_site_transient( Naulon_Updater::TRANSIENT, $this->manifest(), 600 );
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();
		$updates = get_site_transient( 'update_plugins' );

		$this->assertArrayHasKey( $file, (array) $updates->response );
		$this->assertSame( '9.9.9', $updates->response[ $file ]->new_version );

		set_site_transient( Naulon_Updater::TRANSIENT, $this->manifest( array( 'version' => NAULON_VERSION ) ), 600 );
		delete_site_transient( 'update_plugins' );
		wp_update_plugins();
		$updates = get_site_transient( 'update_plugins' );

		$this->assertArrayNotHasKey( $file, (array) $updates->response, 'an equal version would nag forever' );
		$this->assertArrayHasKey( $file, (array) $updates->no_update, 'without this there is no auto-update toggle' );
	}
}
