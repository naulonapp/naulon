<?php
/**
 * Who may touch what.
 *
 * Payout addresses are the most sensitive thing this plugin stores: changing one redirects
 * somebody else's money. So the rule is checked against the user being edited, never against the
 * screen being viewed — `user-edit.php` is the same profile screen pointed at a different person,
 * and a check that only asked "may you see a profile screen?" would let any author reroute any
 * other author's earnings.
 *
 * @package naulon
 */

class AdminAccessTest extends WP_UnitTestCase {

	const WALLET       = '0x1111111111111111111111111111111111111111';
	const OTHER_WALLET = '0x2222222222222222222222222222222222222222';

	/** @var int */
	private $author;

	/** @var int */
	private $other_author;

	/** @var int */
	private $editor;

	public function set_up() {
		parent::set_up();
		$this->author       = self::factory()->user->create( array( 'role' => 'author' ) );
		$this->other_author = self::factory()->user->create( array( 'role' => 'author' ) );
		$this->editor       = self::factory()->user->create( array( 'role' => 'editor' ) );
	}

	public function tear_down() {
		$_POST = array();
		wp_set_current_user( 0 );
		parent::tear_down();
	}

	/**
	 * Turn wp_die into an exception so a refusal can be asserted instead of killing the suite.
	 *
	 * @return callable
	 */
	public function die_handler() {
		return function ( $message ) {
			throw new RuntimeException( is_string( $message ) ? $message : 'wp_die' );
		};
	}

	// ── The wallet rule ──────────────────────────────────────────────────────────────────────

	public function test_an_author_may_edit_their_own_wallet() {
		wp_set_current_user( $this->author );
		$this->assertTrue( Naulon_Roles::can_edit_wallet( $this->author ) );
	}

	public function test_an_author_may_not_edit_another_authors_wallet() {
		wp_set_current_user( $this->author );
		$this->assertFalse( Naulon_Roles::can_edit_wallet( $this->other_author ) );
	}

	public function test_an_editor_may_edit_anyones_wallet() {
		wp_set_current_user( $this->editor );
		$this->assertTrue( Naulon_Roles::can_edit_wallet( $this->other_author ) );
	}

	public function test_the_people_screen_refuses_to_save_a_wallet_for_someone_else() {
		wp_set_current_user( $this->author );
		$_POST = array(
			'naulon_user'   => (string) $this->other_author,
			'naulon_wallet' => self::WALLET,
		);

		add_filter( 'wp_die_handler', array( $this, 'die_handler' ) );
		$refused = false;
		try {
			Naulon_Admin_People::save_wallet();
		} catch ( RuntimeException $e ) {
			$refused = true;
		}
		remove_filter( 'wp_die_handler', array( $this, 'die_handler' ) );

		$this->assertTrue( $refused, 'an author must not be able to reroute another author’s money' );
		$this->assertSame( '', (string) get_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_an_editor_saving_a_wallet_stores_it_normalized() {
		wp_set_current_user( $this->editor );
		$_POST = array(
			'naulon_user'   => (string) $this->other_author,
			'naulon_wallet' => '  0x' . strtoupper( substr( self::WALLET, 2 ) ) . '  ',
		);

		Naulon_Admin_People::save_wallet();

		$this->assertSame( self::WALLET, get_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_the_burn_address_is_refused_at_save_time() {
		wp_set_current_user( $this->editor );
		$_POST = array(
			'naulon_user'   => (string) $this->other_author,
			'naulon_wallet' => '0x0000000000000000000000000000000000000000',
		);

		Naulon_Admin_People::save_wallet();

		$this->assertSame( '', (string) get_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_clearing_a_wallet_is_allowed_and_means_read_free() {
		wp_set_current_user( $this->editor );
		update_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		$_POST = array(
			'naulon_user'   => (string) $this->other_author,
			'naulon_wallet' => '',
		);

		Naulon_Admin_People::save_wallet();

		$this->assertSame( '', (string) get_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	// ── The profile card ─────────────────────────────────────────────────────────────────────

	public function test_the_profile_card_saves_an_authors_own_wallet() {
		wp_set_current_user( $this->author );
		$_POST = array(
			'naulon_wallet_nonce' => wp_create_nonce( Naulon_Profile::NONCE ),
			'naulon_wallet'       => self::WALLET,
		);

		Naulon_Profile::instance()->save( $this->author );

		$this->assertSame( self::WALLET, get_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_the_profile_card_ignores_a_save_aimed_at_another_user() {
		wp_set_current_user( $this->author );
		$_POST = array(
			'naulon_wallet_nonce' => wp_create_nonce( Naulon_Profile::NONCE ),
			'naulon_wallet'       => self::WALLET,
		);

		Naulon_Profile::instance()->save( $this->other_author );

		$this->assertSame( '', (string) get_user_meta( $this->other_author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_the_profile_card_ignores_a_save_with_no_nonce() {
		wp_set_current_user( $this->author );
		$_POST = array( 'naulon_wallet' => self::WALLET );

		Naulon_Profile::instance()->save( $this->author );

		$this->assertSame( '', (string) get_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	public function test_a_malformed_address_keeps_the_old_one_rather_than_wiping_it() {
		wp_set_current_user( $this->author );
		update_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		$_POST = array(
			'naulon_wallet_nonce' => wp_create_nonce( Naulon_Profile::NONCE ),
			'naulon_wallet'       => '0xnothex',
		);

		Naulon_Profile::instance()->save( $this->author );

		$this->assertSame( self::WALLET, get_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, true ) );
	}

	// ── Screens ──────────────────────────────────────────────────────────────────────────────

	public function test_an_author_cannot_open_the_setup_screen() {
		wp_set_current_user( $this->author );

		add_filter( 'wp_die_handler', array( $this, 'die_handler' ) );
		$refused = false;
		try {
			ob_start();
			Naulon_Admin::instance()->render_setup();
			ob_end_clean();
		} catch ( RuntimeException $e ) {
			ob_end_clean();
			$refused = true;
		}
		remove_filter( 'wp_die_handler', array( $this, 'die_handler' ) );

		$this->assertTrue( $refused );
	}

	public function test_an_author_sees_only_their_own_earnings() {
		wp_set_current_user( $this->author );
		update_user_meta( $this->author, Naulon_Credits::USER_WALLET_META, self::WALLET );

		Naulon_Ledger::record(
			array(
				'slug'           => 'blog/a',
				'settlement_ref' => '0xmine',
				'legs'           => array(
					array( 'role' => 'author', 'requirements' => array( 'payTo' => self::WALLET, 'amount' => '3000' ) ),
				),
				'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
			)
		);
		Naulon_Ledger::record(
			array(
				'slug'           => 'blog/b',
				'settlement_ref' => '0xtheirs',
				'legs'           => array(
					array( 'role' => 'author', 'requirements' => array( 'payTo' => self::OTHER_WALLET, 'amount' => '9000' ) ),
				),
				'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
			)
		);

		ob_start();
		Naulon_Admin_Earnings::render();
		$html = ob_get_clean();

		$this->assertStringContainsString( '0.003000', $html );
		$this->assertStringNotContainsString( '0.009000', $html, 'an author must never see another author’s earnings' );
		$this->assertStringNotContainsString( self::OTHER_WALLET, $html );
	}

	public function test_an_editor_sees_the_whole_site() {
		wp_set_current_user( $this->editor );
		Naulon_Ledger::record(
			array(
				'slug'           => 'blog/b',
				'settlement_ref' => '0xtheirs',
				'legs'           => array(
					array( 'role' => 'author', 'requirements' => array( 'payTo' => self::OTHER_WALLET, 'amount' => '9000' ) ),
				),
				'mode'           => Naulon_Ledger::MODE_AUTHOR_SYNC,
			)
		);

		ob_start();
		Naulon_Admin_Earnings::render();
		$html = ob_get_clean();

		$this->assertStringContainsString( '0.009000', $html );
	}

	// ── The per-post box ─────────────────────────────────────────────────────────────────────

	public function test_marking_a_post_free_requires_the_nonce() {
		wp_set_current_user( $this->editor );
		$post_id = self::factory()->post->create( array( 'post_author' => $this->editor ) );
		$_POST   = array( 'naulon_post_free' => '1' );

		Naulon_Admin_Content::save_meta_box( $post_id );

		$this->assertSame( '', (string) get_post_meta( $post_id, Naulon_Credits::POST_TOLL_META, true ) );
	}

	public function test_marking_a_post_free_stores_the_opt_out_and_unmarking_removes_it() {
		wp_set_current_user( $this->editor );
		$post_id = self::factory()->post->create( array( 'post_author' => $this->editor ) );

		$_POST = array(
			'naulon_post_toll_nonce' => wp_create_nonce( 'naulon_post_toll' ),
			'naulon_post_free'       => '1',
		);
		Naulon_Admin_Content::save_meta_box( $post_id );
		$this->assertSame( 'free', get_post_meta( $post_id, Naulon_Credits::POST_TOLL_META, true ) );

		$_POST = array( 'naulon_post_toll_nonce' => wp_create_nonce( 'naulon_post_toll' ) );
		Naulon_Admin_Content::save_meta_box( $post_id );
		$this->assertSame( '', (string) get_post_meta( $post_id, Naulon_Credits::POST_TOLL_META, true ) );
	}

	public function test_a_post_marked_free_is_not_tollable() {
		$post_id = self::factory()->post->create( array( 'post_author' => $this->author, 'post_status' => 'publish' ) );
		update_post_meta( $post_id, Naulon_Credits::POST_TOLL_META, 'free' );

		$this->assertFalse( Naulon_Credits::instance()->is_tollable( get_post( $post_id ) ) );
	}
}
