<?php
/**
 * The toll path, end to end, with the control plane stubbed at WordPress's own HTTP layer
 * (`pre_http_request`). Stubbing there rather than mocking our client means the real request
 * assembly runs — URL, method, auth header, JSON body — so a wrong path or a missing header
 * shows up as a failing test rather than as a 401 in production.
 *
 * The first test is the most important one in this repository. If it ever fails, the product's
 * central promise is broken.
 *
 * @package naulon
 */

class EnforcerTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';
	const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

	/** @var array[] Every outbound request the plugin attempted. */
	private $requests = array();

	/** @var array<string, array> Canned responses, keyed by a path fragment. */
	private $responses = array();

	/** @var int */
	private $post_id;

	public function set_up() {
		parent::set_up();

		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		update_option( 'permalink_structure', '/blog/%postname%/' );

		$this->post_id = self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'tolled-post',
				'post_title'  => 'Tolled Post',
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

		$this->requests  = array();
		$this->responses = array(
			'/_naulon/quote' => array(
				'code' => 200,
				'body' => array(
					'slug'    => 'blog/tolled-post',
					'price'   => 5000,
					'payees'  => array( array( 'address' => self::WALLET, 'shareBps' => 10000 ) ),
					'x402'    => array(
						'header' => 'x402-header-bytes',
						'legs'   => array( array( 'role' => 'author' ) ),
					),
				),
			),
		);

		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		$this->as_human();
		Naulon_Enforcer::instance()->reset();
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		foreach ( array( 'HTTP_USER_AGENT', 'HTTP_ACCEPT', 'HTTP_PAYMENT_SIGNATURE', 'HTTP_X_NAULON_LICENSE', 'HTTP_X_WP_NONCE', 'HTTP_REFERER', 'HTTP_ORIGIN', 'HTTP_X_NAULON_KIND' ) as $k ) {
			unset( $_SERVER[ $k ] );
		}
		delete_transient( 'naulon_402_' . md5( 'blog/tolled-post|read' ) );
		Naulon_Enforcer::instance()->reset();
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	/**
	 * Stand in for the control plane.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  Target URL.
	 * @return array
	 */
	public function intercept( $pre, $args, $url ) {
		$this->requests[] = array( 'url' => $url, 'args' => $args );
		foreach ( $this->responses as $fragment => $canned ) {
			if ( false !== strpos( $url, $fragment ) ) {
				if ( isset( $canned['error'] ) ) {
					return new WP_Error( 'http_request_failed', $canned['error'] );
				}
				return array(
					'headers'  => array(),
					'body'     => wp_json_encode( $canned['body'] ),
					'response' => array( 'code' => $canned['code'], 'message' => '' ),
				);
			}
		}
		return array(
			'headers'  => array(),
			'body'     => '',
			'response' => array( 'code' => 404, 'message' => '' ),
		);
	}

	private function as_human() {
		$_SERVER['HTTP_USER_AGENT'] = self::CHROME;
		$_SERVER['HTTP_ACCEPT']     = 'text/html,application/xhtml+xml';
	}

	private function as_agent() {
		$_SERVER['HTTP_USER_AGENT'] = 'GPTBot/1.0';
		$_SERVER['HTTP_ACCEPT']     = '*/*';
	}

	private function decide() {
		Naulon_Enforcer::instance()->reset();
		return Naulon_Enforcer::instance()->decide( get_post( $this->post_id ) );
	}

	private function urls() {
		return array_map(
			function ( $r ) {
				return $r['url'];
			},
			$this->requests
		);
	}

	// ── The promise ──────────────────────────────────────────────────────────────────────

	public function test_a_human_is_never_charged_and_never_waits_on_the_network() {
		$decision = $this->decide();

		$this->assertSame( 'free', $decision['action'] );
		$this->assertStringContainsString( 'human', $decision['reason'] );
		// Not one outbound request. A reader must never be blocked on the control plane.
		$this->assertSame( array(), $this->urls(), 'a human request must make zero remote calls' );
	}

	public function test_a_search_indexer_reads_free() {
		$_SERVER['HTTP_USER_AGENT'] = 'Googlebot/2.1';
		$_SERVER['HTTP_ACCEPT']     = '*/*';
		$this->assertSame( 'free', $this->decide()['action'] );
	}

	// ── The toll ─────────────────────────────────────────────────────────────────────────

	public function test_an_agent_with_no_payment_gets_the_price() {
		$this->as_agent();
		$decision = $this->decide();

		$this->assertSame( 'pay', $decision['action'] );
		$this->assertSame( 'x402-header-bytes', $decision['header'] );
	}

	public function test_the_402_is_asked_for_with_build_402_and_an_authorized_key() {
		$this->as_agent();
		$this->decide();

		$this->assertCount( 1, $this->requests );
		$url = $this->requests[0]['url'];
		$this->assertStringContainsString( '/_naulon/quote', $url );
		$this->assertStringContainsString( 'build=402', $url );
		$this->assertStringContainsString( 'slug=blog%2Ftolled-post', $url );
		$this->assertStringStartsWith( 'Bearer nln_live_', $this->requests[0]['args']['headers']['Authorization'] );
	}

	public function test_the_built_402_is_cached_so_a_crawler_flood_costs_one_call() {
		$this->as_agent();
		$this->decide();
		$this->decide();
		$this->decide();

		$quote_calls = array_filter(
			$this->urls(),
			function ( $u ) {
				return false !== strpos( $u, '/_naulon/quote' );
			}
		);
		$this->assertCount( 1, $quote_calls, 'the 402 carries no nonce in gateway mode, so it is reusable' );
	}

	public function test_a_free_resource_is_cached_as_free_and_never_re_asked() {
		$this->responses['/_naulon/quote'] = array( 'code' => 204, 'body' => null );
		$this->as_agent();

		$this->assertSame( 'free', $this->decide()['action'] );
		$this->assertSame( 'free', $this->decide()['action'] );
		$this->assertCount( 1, $this->requests, '204 is an answer, not a failure — cache it' );
	}

	// ── Settlement ───────────────────────────────────────────────────────────────────────

	public function test_a_presented_payment_is_settled_and_the_article_is_served_with_receipt_and_license() {
		$this->responses['/_naulon/verify'] = array(
			'code' => 200,
			'body' => array(
				'ok'             => true,
				'settlementRef'  => '0xdeadbeef',
				'responseHeader' => 'receipt-bytes',
				'licenseJws'     => 'the.license.jws',
			),
		);
		$this->as_agent();
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'buyer-signature';

		$decision = $this->decide();

		$this->assertSame( 'settled', $decision['action'] );
		$this->assertSame( 'receipt-bytes', $decision['receipt'] );
		$this->assertSame( 'the.license.jws', $decision['license'] );
	}

	public function test_settlement_sends_back_the_legs_and_quote_exactly_as_received() {
		// /verify re-derives the legs a quote implies and refuses a mismatch. Anything we
		// invented or reshaped here would fail that check — and the x402 wrapper must not be
		// echoed back as part of the quote.
		$this->responses['/_naulon/verify'] = array( 'code' => 200, 'body' => array( 'ok' => true ) );
		$this->as_agent();
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'buyer-signature';
		$this->decide();

		$verify = null;
		foreach ( $this->requests as $r ) {
			if ( false !== strpos( $r['url'], '/_naulon/verify' ) ) {
				$verify = json_decode( $r['args']['body'], true );
			}
		}
		$this->assertNotNull( $verify );
		$this->assertSame( 'buyer-signature', $verify['payment'] );
		$this->assertSame( array( array( 'role' => 'author' ) ), $verify['legs'] );
		$this->assertArrayNotHasKey( 'x402', $verify['quote'], 'the quote must go back as the gate priced it' );
		$this->assertSame( 5000, $verify['quote']['price'] );
		$this->assertStringContainsString( 'tolled-post', $verify['resource'] );
	}

	public function test_a_failed_settlement_re_presents_the_bill_rather_than_serving() {
		$this->responses['/_naulon/verify'] = array( 'code' => 402, 'body' => array( 'ok' => false, 'error' => 'settlement failed' ) );
		$this->as_agent();
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'buyer-signature';

		$decision = $this->decide();
		$this->assertSame( 'pay', $decision['action'] );
		$this->assertSame( 'settlement failed', $decision['reason'] );
	}

	// ── Re-read ──────────────────────────────────────────────────────────────────────────

	public function test_a_valid_license_re_reads_free_without_paying_again() {
		$this->responses['/_naulon/license/check'] = array( 'code' => 200, 'body' => array( 'entitled' => true ) );
		$this->as_agent();
		$_SERVER['HTTP_X_NAULON_LICENSE'] = 'the.license.jws';

		$decision = $this->decide();
		$this->assertSame( 'reread', $decision['action'] );
		// No quote was even fetched — the read was already paid for.
		$this->assertSame( array(), array_filter( $this->urls(), function ( $u ) {
			return false !== strpos( $u, '/_naulon/quote' );
		} ) );
	}

	public function test_an_invalid_license_falls_through_to_the_402_and_is_never_trusted() {
		$this->responses['/_naulon/license/check'] = array( 'code' => 200, 'body' => array( 'entitled' => false ) );
		$this->as_agent();
		$_SERVER['HTTP_X_NAULON_LICENSE'] = 'forged';

		$this->assertSame( 'pay', $this->decide()['action'] );
	}

	public function test_an_unreachable_license_check_does_not_serve_on_an_unverified_claim() {
		// If it did, the license header would become a password for free reads.
		$this->responses['/_naulon/license/check'] = array( 'error' => 'connection refused' );
		$this->as_agent();
		$_SERVER['HTTP_X_NAULON_LICENSE'] = 'anything';

		$this->assertSame( 'pay', $this->decide()['action'] );
	}

	// ── Never break the site ─────────────────────────────────────────────────────────────

	public function test_an_unreachable_control_plane_serves_the_agent_free_rather_than_breaking() {
		$this->responses['/_naulon/quote'] = array( 'error' => 'connection refused' );
		$this->as_agent();

		$this->assertSame( 'free', $this->decide()['action'] );
	}

	public function test_a_failure_is_not_cached_so_the_next_request_tries_again() {
		$this->responses['/_naulon/quote'] = array( 'error' => 'connection refused' );
		$this->as_agent();
		$this->decide();
		$this->decide();

		$this->assertCount( 2, $this->requests );
	}

	public function test_a_revoked_key_is_never_a_silent_free_serve_forever() {
		$this->responses['/_naulon/quote'] = array( 'code' => 401, 'body' => array( 'error' => 'unauthorized' ) );
		$this->as_agent();
		$this->decide();
		$this->decide();

		// Serving free is right; caching the 401 would hide a revoked key until the TTL expired.
		$this->assertCount( 2, $this->requests );
	}

	// ── First-party ──────────────────────────────────────────────────────────────────────

	public function test_the_sites_own_front_end_is_never_tolled() {
		$this->as_agent(); // even with a bot-shaped UA
		$_SERVER['HTTP_X_WP_NONCE'] = 'a-nonce';
		$this->assertSame( 'free', $this->decide()['action'] );
	}

	public function test_a_same_origin_referer_is_first_party() {
		$this->as_agent();
		$_SERVER['HTTP_REFERER'] = home_url( '/some-page/' );
		$this->assertSame( 'free', $this->decide()['action'] );
	}

	public function test_a_cross_origin_referer_is_not_first_party() {
		$this->as_agent();
		$_SERVER['HTTP_REFERER'] = 'https://someone-else.example/';
		$this->assertSame( 'pay', $this->decide()['action'] );
	}

	public function test_a_logged_in_user_is_never_tolled() {
		$this->as_agent();
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'subscriber' ) ) );
		$this->assertSame( 'free', $this->decide()['action'] );
		wp_set_current_user( 0 );
	}

	// ── Preconditions ────────────────────────────────────────────────────────────────────

	public function test_nothing_is_tolled_before_ownership_is_verified() {
		// Without a verified challenge the control plane refuses to settle for this host, so a
		// 402 we issued could never be completed. Charging for a transaction we cannot finish
		// is worse than serving free.
		Naulon_Settings::update( array( 'verified_at' => '' ) );
		$this->as_agent();

		$this->assertSame( 'free', $this->decide()['action'] );
		$this->assertSame( array(), $this->urls() );
	}

	public function test_nothing_is_tolled_while_enforcement_is_switched_off() {
		Naulon_Settings::update( array( 'enforcement_on' => false ) );
		$this->as_agent();
		$this->assertSame( 'free', $this->decide()['action'] );
	}

	public function test_a_wallet_less_article_is_never_tolled() {
		$orphan = self::factory()->post->create(
			array(
				'post_author' => self::factory()->user->create( array( 'role' => 'author' ) ),
				'post_name'   => 'no-wallet',
				'post_status' => 'publish',
			)
		);
		$this->as_agent();
		Naulon_Enforcer::instance()->reset();

		$decision = Naulon_Enforcer::instance()->decide( get_post( $orphan ) );
		$this->assertSame( 'free', $decision['action'] );
		$this->assertSame( array(), $this->urls(), 'nothing to price when there is nobody to pay' );
	}

	public function test_a_citation_is_priced_as_a_citation_not_a_read() {
		$this->as_agent();
		$_SERVER['HTTP_X_NAULON_KIND'] = 'citation';
		$this->decide();

		$this->assertStringContainsString( 'kind=citation', $this->requests[0]['url'] );
		delete_transient( 'naulon_402_' . md5( 'blog/tolled-post|citation' ) );
	}

	public function test_a_402_carrying_a_replay_nonce_is_never_cached() {
		// In mock mode each leg carries its own single-use nonce. Serving a cached nonce to a
		// second agent would make that agent's payment fail against an already-spent nonce.
		$this->responses['/_naulon/quote']['body']['x402']['legs'] = array(
			array( 'role' => 'author', 'requirements' => array( 'extra' => array( 'nonce' => 'single-use' ) ) ),
		);
		$this->as_agent();
		$this->decide();
		$this->decide();

		$quote_calls = array_filter( $this->urls(), function ( $u ) {
			return false !== strpos( $u, '/_naulon/quote' );
		} );
		$this->assertCount( 2, $quote_calls, 'a nonced 402 must be fetched fresh every time' );
	}
}
