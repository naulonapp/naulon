<?php
/**
 * The cache guard and the under-tolling check.
 *
 * A page cache is the failure mode that looks like success, so the test that matters here is the
 * one that distinguishes "a crawler was charged" from "a crawler was served the article" — and
 * the one that makes sure a badly-chosen test article can never produce a false all-clear.
 *
 * @package naulon
 */

class CacheGuardTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';

	/** @var string */
	private $dropin;

	/** @var int */
	private $response_code = 402;

	/** @var bool */
	private $transport_error = false;

	/** @var array */
	private $response_headers = array();

	/** @var string */
	private $requested_ua = '';

	public function set_up() {
		parent::set_up();

		$this->dropin = get_temp_dir() . 'naulon-cache-guard-test.php';
		add_filter( 'naulon_dropin_path', array( $this, 'dropin_path' ) );

		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'probe-post',
				'post_status' => 'publish',
			)
		);

		$this->response_code    = 402;
		$this->transport_error  = false;
		$this->response_headers = array();
		$this->requested_ua     = '';
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		remove_filter( 'naulon_dropin_path', array( $this, 'dropin_path' ) );
		if ( file_exists( $this->dropin ) ) {
			unlink( $this->dropin );
		}
		parent::tear_down();
	}

	public function dropin_path() {
		return $this->dropin;
	}

	/**
	 * @param mixed  $pre  Short circuit.
	 * @param array  $args Args.
	 * @param string $url  URL.
	 * @return array|WP_Error
	 */
	public function intercept( $pre, $args, $url ) {
		$this->requested_ua = isset( $args['headers']['User-Agent'] ) ? (string) $args['headers']['User-Agent'] : '';
		if ( $this->transport_error ) {
			return new WP_Error( 'http_request_failed', 'connection refused' );
		}
		return array(
			'headers'  => $this->response_headers,
			'body'     => '',
			'response' => array( 'code' => $this->response_code, 'message' => '' ),
		);
	}

	// ── The drop-in ──────────────────────────────────────────────────────────────────────────

	public function test_it_reports_honestly_that_nothing_is_installed() {
		$state = Naulon_Cache::dropin_state();
		$this->assertFalse( $state['installed'] );
		$this->assertFalse( $state['current'] );
	}

	public function test_installing_writes_a_guard_that_knows_where_the_classifier_lives() {
		$result = Naulon_Cache::install_dropin();

		$this->assertTrue( $result['ok'], $result['message'] );
		$this->assertFileExists( $this->dropin );

		$contents = file_get_contents( $this->dropin );
		$this->assertStringNotContainsString( '{{AGENT_CLASS_PATH}}', $contents, 'the placeholder must be filled in' );
		// One user-agent list on the site: the guard points at the classifier rather than
		// carrying a second copy that could drift from it.
		$this->assertStringContainsString( 'class-naulon-agent.php', $contents );
		$this->assertStringContainsString( 'DONOTCACHEPAGE', $contents );
	}

	public function test_an_installed_guard_is_recognized_as_current() {
		Naulon_Cache::install_dropin();

		$state = Naulon_Cache::dropin_state();
		$this->assertTrue( $state['installed'] );
		$this->assertTrue( $state['current'] );
		$this->assertSame( Naulon_Cache::DROPIN_VERSION, $state['version'] );
	}

	public function test_an_older_guard_is_recognized_as_stale_rather_than_ignored() {
		file_put_contents( $this->dropin, "<?php\ndefine( 'NAULON_CACHE_GUARD_VERSION', 0 );\n" );

		$state = Naulon_Cache::dropin_state();
		$this->assertTrue( $state['installed'] );
		$this->assertFalse( $state['current'] );
	}

	public function test_removing_it_removes_it() {
		Naulon_Cache::install_dropin();
		$result = Naulon_Cache::remove_dropin();

		$this->assertTrue( $result['ok'] );
		$this->assertFileDoesNotExist( $this->dropin );
	}

	public function test_the_guard_is_valid_php() {
		Naulon_Cache::install_dropin();
		$output = array();
		$code   = 0;
		exec( 'php -l ' . escapeshellarg( $this->dropin ) . ' 2>&1', $output, $code );

		$this->assertSame( 0, $code, implode( "\n", $output ) );
	}

	// ── The exclusion list ───────────────────────────────────────────────────────────────────

	public function test_the_exclusion_list_is_the_same_list_that_decides_who_is_charged() {
		// If these two ever diverge, a publisher pastes an exclusion list that misses exactly the
		// crawlers being charged — and every one of them is served from cache, free.
		$this->assertSame( Naulon_Agent::KNOWN_AGENT_UA, Naulon_Cache::exclusion_fragments() );
	}

	// ── The probe ────────────────────────────────────────────────────────────────────────────

	public function test_a_charged_crawler_is_reported_as_enforcing() {
		$this->response_code = 402;

		$result = Naulon_Cache::probe();

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'enforcing', $result['verdict'] );
	}

	public function test_the_probe_presents_a_crawler_user_agent_the_plugin_actually_charges() {
		Naulon_Cache::probe();

		$verdict = Naulon_Agent::classify( array( 'user_agent' => $this->requested_ua ) );
		$this->assertSame( 'agent', $verdict['kind'], 'a probe the classifier reads as human would always pass' );
	}

	public function test_an_article_served_free_to_a_crawler_is_reported_as_under_tolling() {
		$this->response_code    = 200;
		$this->response_headers = array( 'cf-cache-status' => 'HIT', 'age' => '3600' );

		$result = Naulon_Cache::probe();

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'under_tolling', $result['verdict'] );
		// The headers name the layer that answered, which is the actionable part.
		$this->assertSame( 'HIT', $result['headers']['cf-cache-status'] );
	}

	public function test_a_site_with_no_tollable_article_says_so_instead_of_passing() {
		foreach ( get_posts( array( 'numberposts' => -1, 'post_status' => 'any' ) ) as $post ) {
			wp_delete_post( $post->ID, true );
		}

		$result = Naulon_Cache::probe();

		$this->assertFalse( $result['ok'] );
		$this->assertSame( 'no_post', $result['verdict'] );
		$this->assertFalse( $result['tested'] );
	}

	public function test_a_loopback_failure_is_not_reported_as_under_tolling() {
		// A host that blocks loopback requests would otherwise look exactly like a cache serving
		// crawlers for free, and send the publisher chasing the wrong problem.
		$this->transport_error = true;

		$result = Naulon_Cache::probe();

		$this->assertSame( 'unreachable', $result['verdict'] );
		$this->assertFalse( $result['tested'] );
	}
}
