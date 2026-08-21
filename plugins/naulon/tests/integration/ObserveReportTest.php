<?php
/**
 * What reaches the audit plane, what never does, and what happens when it cannot be delivered.
 *
 * The gap this closes was measured on a live publisher on 2026-08-22: three real GPTBot 402s
 * produced zero rows in the control plane, so two setup screens told a site that was actively
 * tolling that nothing had ever been priced. Every assertion below is one half of that:
 * decisions leave, readers do not, and money is not ours to claim.
 *
 * @package naulon
 */

class ObserveReportTest extends WP_UnitTestCase {

	const WALLET   = '0x1111111111111111111111111111111111111111';
	const COAUTHOR = '0x2222222222222222222222222222222222222222';
	const CHROME   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

	/** @var int */
	private $post_id;

	/** @var array Bodies posted to /_naulon/observe, decoded, in order. */
	private $observed = array();

	/** @var int What /_naulon/observe answers next. */
	private $observe_code = 202;

	/** @var bool Should the transport fail outright (a timeout, not a status)? */
	private $observe_transport_fails = false;

	/** @var array */
	private $responses = array();

	public function set_up() {
		parent::set_up();

		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		update_option( 'permalink_structure', '/blog/%postname%/' );

		$this->post_id = self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'tolled-post',
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

		$challenge = base64_encode(
			wp_json_encode(
				array(
					'x402Version' => 2,
					'accepts'     => array( array( 'amount' => '5000', 'payTo' => self::WALLET ) ),
					'extensions'  => array(
						'naulonLegs' => array( 'version' => 1, 'settlement' => 'author-sync-rest-deferred' ),
					),
				)
			)
		);

		$this->responses = array(
			'/_naulon/quote'  => array(
				'code' => 200,
				'body' => array(
					'slug'   => 'blog/tolled-post',
					'price'  => 5000,
					'payees' => array( array( 'address' => self::WALLET, 'shareBps' => 10000 ) ),
					'x402'   => array(
						'header' => $challenge,
						'legs'   => array(
							array(
								'role'         => 'author',
								'requirements' => array( 'payTo' => self::WALLET, 'amount' => '3000', 'network' => 'eip155:84532' ),
							),
							array(
								'role'         => 'coauthor',
								'requirements' => array( 'payTo' => self::COAUTHOR, 'amount' => '2000', 'network' => 'eip155:84532' ),
							),
						),
					),
				),
			),
			'/_naulon/verify' => array(
				'code' => 200,
				'body' => array(
					'ok'             => true,
					'settlementRef'  => '0xsettled',
					'payer'          => '0x9999999999999999999999999999999999999999',
					'responseHeader' => 'receipt',
					'licenseJws'     => 'license',
				),
			),
		);

		Naulon_Observer::clear();
		Naulon_Observer::instance()->reset();
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		Naulon_Enforcer::instance()->reset();
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		foreach ( array( 'HTTP_USER_AGENT', 'HTTP_ACCEPT', 'HTTP_PAYMENT_SIGNATURE' ) as $key ) {
			unset( $_SERVER[ $key ] );
		}
		delete_transient( 'naulon_402_' . md5( 'blog/tolled-post|read' ) );
		Naulon_Observer::clear();
		Naulon_Observer::instance()->reset();
		Naulon_Enforcer::instance()->reset();
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	/**
	 * @param mixed  $pre  Short circuit.
	 * @param array  $args Args.
	 * @param string $url  URL.
	 * @return array|WP_Error
	 */
	public function intercept( $pre, $args, $url ) {
		if ( false !== strpos( $url, '/_naulon/observe' ) ) {
			if ( $this->observe_transport_fails ) {
				return new WP_Error( 'http_request_failed', 'cURL error 28: timed out' );
			}
			$this->observed[] = json_decode( isset( $args['body'] ) ? $args['body'] : '', true );
			return array(
				'headers'  => array(),
				'body'     => wp_json_encode( 202 === $this->observe_code ? array( 'ok' => true, 'accepted' => 1 ) : array( 'ok' => false, 'error' => 'nope' ) ),
				'response' => array( 'code' => $this->observe_code, 'message' => '' ),
			);
		}
		foreach ( $this->responses as $fragment => $canned ) {
			if ( false !== strpos( $url, $fragment ) ) {
				return array(
					'headers'  => array(),
					'body'     => wp_json_encode( $canned['body'] ),
					'response' => array( 'code' => $canned['code'], 'message' => '' ),
				);
			}
		}
		return array( 'headers' => array(), 'body' => '', 'response' => array( 'code' => 404, 'message' => '' ) );
	}

	private function decide() {
		Naulon_Enforcer::instance()->reset();
		return Naulon_Enforcer::instance()->decide( get_post( $this->post_id ) );
	}

	private function crawl() {
		$_SERVER['HTTP_USER_AGENT'] = 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)';
		$_SERVER['HTTP_ACCEPT']     = '*/*';
		$this->decide();
		Naulon_Observer::instance()->flush();
	}

	/** The single batch this test sent, flattened. */
	private function sent() {
		$this->assertCount( 1, $this->observed, 'exactly one call to /_naulon/observe' );
		return $this->observed[0];
	}

	// ── What leaves ──────────────────────────────────────────────────────────────────────────

	public function test_an_unpaid_crawler_is_reported_as_denied_with_the_price_it_walked_away_from() {
		$this->crawl();

		$batch = $this->sent();
		$this->assertCount( 1, $batch );
		$report = $batch[0];

		$this->assertSame( 'denied', $report['verdict'] );
		$this->assertSame( 'agent', $report['classifiedAs'] );
		$this->assertSame( 'blog/tolled-post', $report['slug'] );
		$this->assertSame( 'read', $report['kind'] );
		// 3000 + 2000, copied from the legs the control plane priced. Integer micro-USDC.
		$this->assertSame( 5000, $report['priceMicro'] );
		$this->assertStringContainsString( 'tolled-post', $report['resource'] );
	}

	public function test_the_batch_is_always_a_json_array_even_for_one_decision() {
		$this->crawl();
		$this->assertTrue( array_key_exists( 0, $this->sent() ), 'the body must be a list, not one object' );
	}

	public function test_the_report_says_why_the_caller_was_called_a_machine() {
		$this->crawl();
		$report = $this->sent()[0];

		$this->assertStringContainsString( 'GPTBot', $report['agent']['ua'] );
		$this->assertStringContainsString( 'user-agent matched', $report['agent']['classifyReason'] );
	}

	/**
	 * This plugin does not verify Web Bot Auth signatures (see Naulon_Agent), so it has no
	 * verdict on them. Sending `verified: false` would be a claim, and the audit page would
	 * render a crawler as failing a check nobody ran.
	 */
	public function test_it_claims_nothing_about_signatures_it_never_checked() {
		$this->crawl();
		$agent = $this->sent()[0]['agent'];

		$this->assertArrayNotHasKey( 'verified', $agent );
		$this->assertArrayNotHasKey( 'verifiedAgent', $agent );
		$this->assertArrayNotHasKey( 'sigInvalid', $agent );
	}

	public function test_a_crawler_served_free_is_reported_so_the_gap_is_visible_not_silent() {
		delete_user_meta( get_post( $this->post_id )->post_author, Naulon_Credits::USER_WALLET_META );
		$this->crawl();

		$report = $this->sent()[0];
		$this->assertSame( 'served-free', $report['verdict'] );
		$this->assertArrayNotHasKey( 'priceMicro', $report, 'nothing was priced, so nothing is claimed' );
	}

	// ── What never leaves ────────────────────────────────────────────────────────────────────

	public function test_a_readers_visit_is_never_reported() {
		$_SERVER['HTTP_USER_AGENT'] = self::CHROME;
		$_SERVER['HTTP_ACCEPT']     = 'text/html';

		$this->decide();
		Naulon_Observer::instance()->flush();

		$this->assertSame( array(), $this->observed, 'a human read must reach the control plane in no form at all' );
		$this->assertSame( array(), Naulon_Observer::pending() );
	}

	/**
	 * The integrity line. `paid` is written by the hosted /verify from the settle outcome; a
	 * settled toll reported from here would be a second, unbacked claim that money moved.
	 */
	public function test_a_settlement_is_not_reported_from_here() {
		$_SERVER['HTTP_USER_AGENT']        = 'Mozilla/5.0 (compatible; GPTBot/1.2)';
		$_SERVER['HTTP_ACCEPT']            = '*/*';
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'signed-payment';

		$decision = $this->decide();
		Naulon_Observer::instance()->flush();

		$this->assertSame( 'settled', $decision['action'] );
		$this->assertSame( array(), $this->observed );
	}

	// ── When it cannot be delivered ──────────────────────────────────────────────────────────

	public function test_a_transport_failure_keeps_the_batch_and_the_next_flush_delivers_it() {
		$this->observe_transport_fails = true;
		$this->crawl();

		$this->assertSame( array(), $this->observed );
		$this->assertCount( 1, Naulon_Observer::pending(), 'a timeout must not lose the decision' );
		$this->assertFalse( Naulon_Observer::status()['ok'] );

		$this->observe_transport_fails = false;
		Naulon_Observer::instance()->flush();

		$this->assertCount( 1, $this->sent() );
		$this->assertSame( array(), Naulon_Observer::pending(), 'delivered reports are not sent twice' );
		$this->assertTrue( Naulon_Observer::status()['ok'] );
	}

	/**
	 * A 400 means these bytes will never be accepted. Keeping them would pin a poisoned batch in
	 * front of every later report — the buffer would fill with something unsendable and the audit
	 * page would go quiet for a reason nobody could see.
	 */
	public function test_a_rejected_batch_is_dropped_rather_than_retried_forever() {
		$this->observe_code = 400;
		$this->crawl();

		$this->assertSame( array(), Naulon_Observer::pending() );
		$this->assertSame( 'HTTP 400', Naulon_Observer::status()['error'] );
	}

	public function test_reports_taken_before_the_site_is_connected_are_held_not_dropped() {
		Naulon_Settings::update( array( 'api_key' => '', 'gate_url' => '' ) );

		$_SERVER['HTTP_USER_AGENT'] = 'Mozilla/5.0 (compatible; GPTBot/1.2)';
		$_SERVER['HTTP_ACCEPT']     = '*/*';
		// Enforcement is off without a key, so record directly: the case under test is the
		// buffer's posture, not the enforcer's.
		Naulon_Observer::instance()->record(
			array(
				'resource' => 'https://example.test/blog/tolled-post/',
				'slug'     => 'blog/tolled-post',
				'action'   => 'pay',
				'kind'     => 'read',
				'ua'       => 'GPTBot/1.2',
				'reason'   => 'user-agent matched "gptbot"',
			)
		);
		Naulon_Observer::instance()->flush();

		$this->assertSame( array(), $this->observed );
		$this->assertCount( 1, Naulon_Observer::pending() );
	}

	/**
	 * The endpoint takes 50 per call. A site that was offline for a long crawl keeps the RECENT
	 * decisions — those are the ones a publisher is looking at when they ask whether it works.
	 */
	public function test_the_buffer_is_capped_at_the_endpoints_batch_limit_and_drops_the_oldest() {
		$held = array();
		for ( $i = 0; $i < 60; $i++ ) {
			$held[] = array(
				'resource'     => 'https://example.test/blog/post-' . $i . '/',
				'slug'         => 'blog/post-' . $i,
				'verdict'      => 'denied',
				'classifiedAs' => 'agent',
				'kind'         => 'read',
				'at'           => 1786527880000 + $i,
			);
		}
		update_option( 'naulon_observe_pending', $held, false );

		Naulon_Observer::instance()->flush();

		$batch = $this->sent();
		$this->assertCount( Naulon_Observer::MAX_BATCH, $batch );
		$this->assertSame( 'blog/post-59', $batch[ count( $batch ) - 1 ]['slug'], 'the newest decision survives' );
		$this->assertSame( 'blog/post-10', $batch[0]['slug'], 'the oldest ten were dropped' );
	}
}
