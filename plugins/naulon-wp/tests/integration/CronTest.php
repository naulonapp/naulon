<?php
/**
 * The heartbeat: staying alive upstream, and standing down on a conflict.
 *
 * The conflict case is the one that matters. If this site's domain still points at the hosted
 * gate by DNS and this plugin also enforces, an agent is charged twice for one read. The control
 * plane already detects that; these tests cover the half that has to happen here — fetching the
 * verdict, storing it where the enforcer reads it, and actually standing down.
 *
 * @package naulon
 */

class CronTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';

	/** @var array[] */
	private $requests = array();

	/** @var array */
	private $status_body = array();

	/** @var int */
	private $status_code = 200;

	public function set_up() {
		parent::set_up();

		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		// Pretty permalinks, as any real site has: with plain ones a post has no path to derive a
		// slug from, and nothing is tollable at all (see Naulon_Verification::permalinks_ok).
		update_option( 'permalink_structure', '/blog/%postname%/' );
		self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'heartbeat-post',
				'post_status' => 'publish',
			)
		);

		Naulon_Settings::update(
			array(
				'api_key'        => 'nln_live_' . str_repeat( 'a', 40 ),
				'api_base'       => 'https://api.example.test',
				'verified_at'    => '2026-07-27T00:00:00Z',
				'enforcement_on' => true,
			)
		);

		$this->requests    = array();
		$this->status_code = 200;
		$this->status_body = array(
			'hosts'     => array(
				array( 'host' => wp_parse_url( home_url(), PHP_URL_HOST ), 'mode' => 'in_app', 'nextAction' => 'none', 'attention' => false ),
			),
			'attention' => false,
		);

		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		update_option( 'permalink_structure', '' );
		delete_transient( Naulon_Cron::MODE_TRANSIENT );
		Naulon_Enforcer::instance()->reset();
		parent::tear_down();
	}

	/**
	 * @param mixed  $pre  Short circuit.
	 * @param array  $args Args.
	 * @param string $url  URL.
	 * @return array
	 */
	public function intercept( $pre, $args, $url ) {
		$this->requests[] = $url;
		if ( false !== strpos( $url, '/_naulon/enforce-status' ) ) {
			return array(
				'headers'  => array(),
				'body'     => wp_json_encode( $this->status_body ),
				'response' => array( 'code' => $this->status_code, 'message' => '' ),
			);
		}
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( array( 'price' => 5000 ) ),
			'response' => array( 'code' => 200, 'message' => '' ),
		);
	}

	// ── Classification ───────────────────────────────────────────────────────────────────────

	public function test_the_verdict_for_this_host_is_stored_where_the_enforcer_reads_it() {
		$result = Naulon_Cron::instance()->refresh_status();

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'in_app', $result['mode'] );
		$this->assertSame( 'in_app', get_transient( Naulon_Cron::MODE_TRANSIENT ) );
		$this->assertSame( 'in_app', Naulon_Settings::all()['status_mode'] );
	}

	public function test_another_domains_verdict_is_never_mistaken_for_this_ones() {
		$this->status_body['hosts'] = array(
			array( 'host' => 'someone-else.example', 'mode' => 'conflict', 'nextAction' => 'remove_cname', 'attention' => true ),
		);

		$result = Naulon_Cron::instance()->refresh_status();

		$this->assertSame( '', $result['mode'], 'a verdict about another host says nothing about this one' );
		$this->assertTrue( Naulon_Enforcer::instance()->is_active() );
	}

	public function test_a_conflict_makes_the_plugin_stand_down_even_when_it_is_switched_on() {
		$this->status_body['hosts'][0]['mode']       = 'conflict';
		$this->status_body['hosts'][0]['nextAction'] = 'remove_cname';

		Naulon_Cron::instance()->refresh_status();

		$this->assertFalse(
			Naulon_Enforcer::instance()->is_active(),
			'DNS enforcement plus in-app enforcement would charge the same read twice'
		);
	}

	public function test_an_unclassified_host_does_not_stop_enforcement() {
		// A brand-new domain simply has no verdict yet. Treating that as a conflict would mean a
		// publisher who just installed the plugin earns nothing and is told nothing.
		$this->status_body['hosts'] = array();

		Naulon_Cron::instance()->refresh_status();

		$this->assertSame( '', get_transient( Naulon_Cron::MODE_TRANSIENT ) );
		$this->assertTrue( Naulon_Enforcer::instance()->is_active() );
	}

	public function test_a_rejected_key_is_recorded_as_an_error_a_human_can_read() {
		$this->status_code = 401;
		$this->status_body = array( 'error' => 'unauthorized' );

		$result = Naulon_Cron::instance()->refresh_status();

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( '401', Naulon_Settings::all()['status_error'] );
	}

	// ── Liveness ─────────────────────────────────────────────────────────────────────────────

	public function test_the_heartbeat_prices_a_real_tollable_article() {
		// Only /quote and /verify stamp in-app liveness upstream; a status poll writes nothing.
		// Quoting a resource that is not tollable would answer 204 and prove nothing either.
		$this->assertTrue( Naulon_Cron::instance()->stamp_liveness() );

		$quotes = array_filter(
			$this->requests,
			function ( $url ) {
				return false !== strpos( $url, '/_naulon/quote' );
			}
		);
		$this->assertCount( 1, $quotes );
		$this->assertStringContainsString( 'heartbeat-post', (string) reset( $quotes ) );
	}

	public function test_a_site_with_nothing_tollable_says_so_instead_of_inventing_a_call() {
		foreach ( get_posts( array( 'numberposts' => -1, 'post_status' => 'any' ) ) as $post ) {
			wp_delete_post( $post->ID, true );
		}

		$this->assertFalse( Naulon_Cron::instance()->stamp_liveness() );
		$this->assertSame( 'no tollable post', Naulon_Settings::all()['heartbeat_note'] );
	}

	// ── Scheduling ───────────────────────────────────────────────────────────────────────────

	public function test_a_connected_site_schedules_the_heartbeat() {
		Naulon_Cron::instance()->unschedule();
		Naulon_Cron::instance()->ensure_scheduled();

		$this->assertNotFalse( wp_next_scheduled( Naulon_Cron::EVENT ) );
	}

	public function test_a_disconnected_site_never_phones_home() {
		Naulon_Cron::instance()->ensure_scheduled();
		Naulon_Settings::update( array( 'api_key' => '', 'gate_url' => '' ) );

		Naulon_Cron::instance()->ensure_scheduled();

		$this->assertFalse( wp_next_scheduled( Naulon_Cron::EVENT ) );
	}
}
