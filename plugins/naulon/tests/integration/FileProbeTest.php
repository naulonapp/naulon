<?php
/**
 * The self-test end to end, with the loopback answered by the real file route while the rule is
 * written, and by a static server when it is not. The cached case replays the first answer.
 *
 * @package naulon
 */

class FileProbeTest extends WP_UnitTestCase {

	/** @var string */
	private $htaccess;

	/** @var string routed|static|cached */
	private $server = 'routed';

	/** @var array|null The first answer, replayed in cached mode. */
	private $first;

	/** @var array[] Headers sent to enforce-config. */
	private $config_headers = array();

	public function set_up() {
		parent::set_up();
		require_once ABSPATH . 'wp-admin/includes/file.php';
		$this->htaccess = get_home_path() . '.htaccess';
		file_put_contents( $this->htaccess, "# BEGIN WordPress\n# END WordPress\n" ); // phpcs:ignore
		add_filter( 'got_rewrite', '__return_true' );
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'pdf' ) );
		Naulon_Settings::update(
			array(
				'api_key'  => 'nln_live_' . str_repeat( 'a', 40 ),
				'api_base' => 'https://api.example.test',
			)
		);
		$this->first = null;
	}

	public function tear_down() {
		remove_filter( 'got_rewrite', '__return_true' );
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		unset( $_SERVER['HTTP_X_NAULON_PROBE'] );
		Naulon_File_Probe::instance()->cleanup();
		delete_option( Naulon_Rules::FILE_TYPES_OPTION );
		unlink( $this->htaccess ); // phpcs:ignore
		parent::tear_down();
	}

	public function intercept( $pre, $args, $url ) {
		if ( false !== strpos( $url, '/_naulon/enforce-config' ) ) {
			$this->config_headers[] = $args['headers'];
			return array(
				'headers'  => array(),
				'body'     => '{}',
				'response' => array( 'code' => 200, 'message' => '' ),
			);
		}
		if ( false === strpos( $url, Naulon_File_Probe::DIR ) ) {
			return $pre;
		}
		$headers = array();
		if ( 'static' !== $this->server && '' !== implode( '', Naulon_File_Route::instance()->current() ) ) {
			$_SERVER['HTTP_X_NAULON_PROBE'] = $args['headers'][ Naulon_File_Probe::REQUEST_HEADER ];
			$plan                           = Naulon_File_Toll::instance()->plan( Naulon_File_Probe::DIR . '/' . Naulon_File_Probe::FILE );
			foreach ( $plan['headers'] as $line ) {
				list( $name, $value )            = array_map( 'trim', explode( ':', $line, 2 ) );
				$headers[ strtolower( $name ) ] = $value;
			}
		}
		$answer = array(
			'headers'  => new WpOrg\Requests\Utility\CaseInsensitiveDictionary( $headers ),
			'body'     => '',
			'response' => array( 'code' => 200, 'message' => '' ),
		);
		if ( 'cached' === $this->server && false === strpos( $url, '?n=' ) ) {
			if ( null === $this->first ) {
				$this->first = $answer;
			} else {
				$answer                     = $this->first;
				$answer['headers']['cf-cache-status'] = 'HIT';
			}
		}
		return $answer;
	}

	public function test_a_routed_site_is_ok() {
		Naulon_File_Route::instance()->sync();
		$result = Naulon_File_Probe::instance()->run();

		$this->assertSame( 'ok', $result['status'] );
		$this->assertSame( array( 'pdf' ), $result['types'] );
		$this->assertSame( $result, Naulon_File_Probe::instance()->last() );
	}

	public function test_a_server_ignoring_the_rule_is_no_rewrite() {
		Naulon_File_Route::instance()->sync();
		$this->server = 'static';

		$this->assertSame( 'no_rewrite', Naulon_File_Probe::instance()->run()['status'] );
	}

	public function test_a_cache_replaying_the_route_is_cached() {
		Naulon_File_Route::instance()->sync();
		$this->server = 'cached';

		$result = Naulon_File_Probe::instance()->run();
		$this->assertSame( 'cached', $result['status'] );
		$this->assertStringContainsString( 'Cloudflare', $result['detail'] );
	}

	public function test_an_unwritable_site_is_not_writable() {
		remove_filter( 'got_rewrite', '__return_true' );
		add_filter( 'got_rewrite', '__return_false' );
		Naulon_File_Route::instance()->sync();

		$this->assertSame( 'not_writable', Naulon_File_Probe::instance()->run()['status'] );
		remove_filter( 'got_rewrite', '__return_false' );
	}

	public function test_the_policy_fetch_reports_the_last_result() {
		Naulon_File_Route::instance()->sync();
		Naulon_File_Probe::instance()->run_and_report();

		$last = end( $this->config_headers );
		$this->assertMatchesRegularExpression( '/^ok; types=pdf; at=\d+$/', $last['x-naulon-file-toll'] );
		$this->assertSame( 'fleet-pull', $last['x-naulon-capabilities'] );
	}

	public function test_no_result_sends_no_report() {
		Naulon_Client::instance()->enforce_config( home_url( '/' ) );

		$this->assertArrayNotHasKey( 'x-naulon-file-toll', end( $this->config_headers ) );
	}
}
