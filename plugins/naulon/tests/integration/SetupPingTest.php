<?php
/**
 * Saving a key lights the dashboard's connected step at once, and tells the dashboard whether this
 * site can toll files, instead of both waiting for the first crawler.
 *
 * The Files card's words for every verdict live here too, because the card is what a publisher
 * reads when the dashboard sends them to fix something.
 *
 * @package naulon
 */

class SetupPingTest extends WP_UnitTestCase {

	/** @var string[] */
	private $urls = array();

	public static function wpSetUpBeforeClass() {
		require_once NAULON_PLUGIN_DIR . 'includes/class-naulon-admin.php';
		require_once NAULON_PLUGIN_DIR . 'includes/admin/class-naulon-admin-setup.php';
		require_once NAULON_PLUGIN_DIR . 'includes/admin/class-naulon-admin-diagnostics.php';
	}

	public function set_up() {
		parent::set_up();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		unset( $_POST['naulon_connection'] );
		Naulon_File_Probe::instance()->cleanup();
		Naulon_Rules::instance()->reset();
		parent::tear_down();
	}

	public function intercept( $pre, $args, $url ) {
		$this->urls[] = $url;
		return array(
			'headers'  => array(),
			'body'     => '{}',
			'response' => array( 'code' => 200, 'message' => '' ),
		);
	}

	private function calls_to( $fragment ) {
		return count(
			array_filter(
				$this->urls,
				function ( $u ) use ( $fragment ) {
					return false !== strpos( $u, $fragment );
				}
			)
		);
	}

	public function test_saving_a_key_fetches_the_policy_and_runs_the_file_check() {
		$_POST['naulon_connection'] = 'nln_live_' . str_repeat( 'b', 40 );
		Naulon_Admin_Setup::save_connection();

		$this->assertGreaterThanOrEqual( 1, $this->calls_to( '/_naulon/enforce-config' ) );
		$this->assertNotNull( Naulon_File_Probe::instance()->last() );
		$this->assertSame( 'nln_live_' . str_repeat( 'b', 40 ), Naulon_Settings::all()['api_key'] );
	}

	public function test_a_rejected_key_pings_nothing() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		$reject = function () {
			return array(
				'headers'  => array(),
				'body'     => '{}',
				'response' => array( 'code' => 401, 'message' => '' ),
			);
		};
		add_filter( 'pre_http_request', $reject );
		$_POST['naulon_connection'] = 'nln_live_' . str_repeat( 'c', 40 );
		Naulon_Admin_Setup::save_connection();

		$this->assertNull( Naulon_File_Probe::instance()->last() );
		remove_filter( 'pre_http_request', $reject );
	}

	public function test_the_file_panel_has_one_plain_line_per_verdict() {
		$now  = 1760000000;
		$rows = array(
			'ok'           => array( 'ok', 'Files are tolled on this site.', 'none' ),
			'no_rewrite'   => array( 'bad', 'ignores .htaccess', 'nginx' ),
			'not_writable' => array( 'bad', 'could not write its .htaccess', 'htaccess' ),
			'cached'       => array( 'bad', 'Cloudflare (HIT)', 'cache' ),
			'offloaded'    => array( 'warn', 'media host', 'none' ),
			'unsupported'  => array( 'warn', 'HTTP 401', 'none' ),
		);
		foreach ( $rows as $status => $want ) {
			$panel = Naulon_Admin_Diagnostics::file_panel(
				array(
					'status' => $status,
					'detail' => 'cached' === $status ? 'Cloudflare (HIT)' : 'this site answered its own request with HTTP 401',
					'types'  => array( 'pdf' ),
					'at'     => $now - 180,
				),
				array( 'pdf' ),
				$now
			);
			$this->assertSame( $want[0], $panel['pill'], $status );
			$this->assertStringContainsString( $want[1], $panel['line'], $status );
			$this->assertSame( $want[2], $panel['fix'], $status );
			$this->assertStringContainsString( 'PDF', $panel['scope'] );
		}
		$this->assertSame( 'idle', Naulon_Admin_Diagnostics::file_panel( null, array(), $now )['pill'] );
		$this->assertStringContainsString( 'No file types', Naulon_Admin_Diagnostics::file_panel( null, array(), $now )['scope'] );
	}
}
