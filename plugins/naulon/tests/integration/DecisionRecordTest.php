<?php
/**
 * What the toll writes down, and what it deliberately does not.
 *
 * The privacy line is the first test and the important one: a reader's visit is never recorded,
 * anywhere, for any reason. Not sampled, not counted. Everything past classification is a machine,
 * and machines are the only party this plugin logs.
 *
 * The second half is the money: a settlement has to reach the ledger with the amounts the buyer
 * signed for, because the earnings screens read nothing else.
 *
 * @package naulon
 */

class DecisionRecordTest extends WP_UnitTestCase {

	const WALLET   = '0x1111111111111111111111111111111111111111';
	const COAUTHOR = '0x2222222222222222222222222222222222222222';
	const CHROME   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

	/** @var int */
	private $post_id;

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

		// A 402 with two legs and the settlement semantics the protocol declares, so the ledger
		// has something real to read rather than a shape invented by the test.
		$challenge = base64_encode(
			wp_json_encode(
				array(
					'x402Version' => 2,
					'accepts'     => array( array( 'amount' => '3000', 'payTo' => self::WALLET ) ),
					'extensions'  => array(
						'naulonLegs' => array(
							'version'    => 1,
							'settlement' => 'author-sync-rest-deferred',
						),
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

		Naulon_Log::clear();
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		Naulon_Enforcer::instance()->reset();
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		foreach ( array( 'HTTP_USER_AGENT', 'HTTP_ACCEPT', 'HTTP_PAYMENT_SIGNATURE' ) as $key ) {
			unset( $_SERVER[ $key ] );
		}
		delete_transient( 'naulon_402_' . md5( 'blog/tolled-post|read' ) );
		Naulon_Log::clear();
		Naulon_Enforcer::instance()->reset();
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	/**
	 * @param mixed  $pre  Short circuit.
	 * @param array  $args Args.
	 * @param string $url  URL.
	 * @return array
	 */
	public function intercept( $pre, $args, $url ) {
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

	// ── Privacy ──────────────────────────────────────────────────────────────────────────────

	public function test_a_readers_visit_is_never_recorded() {
		$_SERVER['HTTP_USER_AGENT'] = self::CHROME;
		$_SERVER['HTTP_ACCEPT']     = 'text/html';

		$this->decide();

		$this->assertSame( array(), Naulon_Log::all(), 'a human read must leave no trace at all' );
	}

	public function test_a_reader_on_a_post_nobody_can_be_paid_for_is_still_not_recorded() {
		// The "not tollable" branch runs after classification precisely so this stays true.
		delete_user_meta( get_post( $this->post_id )->post_author, Naulon_Credits::USER_WALLET_META );
		$_SERVER['HTTP_USER_AGENT'] = self::CHROME;
		$_SERVER['HTTP_ACCEPT']     = 'text/html';

		$this->decide();

		$this->assertSame( array(), Naulon_Log::all() );
	}

	// ── Machines ─────────────────────────────────────────────────────────────────────────────

	public function test_a_charged_crawler_is_recorded_with_what_it_asked_for_and_why() {
		$_SERVER['HTTP_USER_AGENT'] = 'GPTBot/1.2';
		$_SERVER['HTTP_ACCEPT']     = '*/*';

		$this->decide();

		$entries = Naulon_Log::all();
		$this->assertCount( 1, $entries );
		$this->assertSame( 'pay', $entries[0]['action'] );
		$this->assertSame( 'blog/tolled-post', $entries[0]['slug'] );
		$this->assertStringContainsString( 'GPTBot', $entries[0]['ua'] );
	}

	public function test_a_crawler_served_free_is_recorded_too_so_a_silent_gap_is_visible() {
		delete_user_meta( get_post( $this->post_id )->post_author, Naulon_Credits::USER_WALLET_META );
		$_SERVER['HTTP_USER_AGENT'] = 'CCBot/2.0';
		$_SERVER['HTTP_ACCEPT']     = '*/*';

		$this->decide();

		$entries = Naulon_Log::all();
		$this->assertCount( 1, $entries );
		$this->assertSame( 'free', $entries[0]['action'] );
		$this->assertStringContainsString( 'not tollable', $entries[0]['reason'] );
	}

	public function test_the_window_stays_bounded() {
		for ( $i = 0; $i < Naulon_Log::MAX_ENTRIES + 10; $i++ ) {
			Naulon_Log::record( array( 'action' => 'pay', 'slug' => 'blog/x-' . $i ) );
		}

		$entries = Naulon_Log::all();
		$this->assertCount( Naulon_Log::MAX_ENTRIES, $entries );
		// Oldest dropped, newest kept.
		$this->assertSame( 'blog/x-' . ( Naulon_Log::MAX_ENTRIES + 9 ), end( $entries )['slug'] );
	}

	// ── Money ────────────────────────────────────────────────────────────────────────────────

	public function test_a_settlement_reaches_the_ledger_with_the_amounts_from_the_402() {
		$_SERVER['HTTP_USER_AGENT']        = 'GPTBot/1.2';
		$_SERVER['HTTP_ACCEPT']            = '*/*';
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'buyer-signature';

		$this->assertSame( 'settled', $this->decide()['action'] );

		$this->assertSame( 3000, Naulon_Ledger::total_for_wallet( self::WALLET, Naulon_Ledger::STATUS_SETTLED ) );
		$this->assertSame( 2000, Naulon_Ledger::total_for_wallet( self::COAUTHOR, Naulon_Ledger::STATUS_PENDING ) );

		$rows = Naulon_Ledger::recent( 10 );
		$this->assertSame( '0xsettled', $rows[0]['settlement_ref'] );
		$this->assertSame( (string) $this->post_id, $rows[0]['post_id'] );
		$this->assertSame( 'blog/tolled-post', $rows[0]['slug'] );
	}

	public function test_a_failed_settlement_writes_no_earnings() {
		$this->responses['/_naulon/verify'] = array( 'code' => 402, 'body' => array( 'ok' => false, 'error' => 'bad signature' ) );
		$_SERVER['HTTP_USER_AGENT']         = 'GPTBot/1.2';
		$_SERVER['HTTP_ACCEPT']             = '*/*';
		$_SERVER['HTTP_PAYMENT_SIGNATURE']  = 'buyer-signature';

		$this->assertSame( 'pay', $this->decide()['action'] );
		$this->assertSame( 0, Naulon_Ledger::site_total( '' ) );
	}
}
