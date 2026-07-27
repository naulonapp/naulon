<?php
/**
 * Plain permalinks — a silent, total failure, and the reason this check exists.
 *
 * It was found by a test that had simply forgotten to set a permalink structure: the heartbeat
 * asked the control plane to price `slug=`. Following that through, plain permalinks mean every
 * article's URL is `?p=123`, which has no path — so the canonical slug is empty, the credits
 * lookup matches nothing, every article reads free, and the rewrite that serves the ownership
 * challenge never fires. Nothing errors. A publisher would see a connected plugin earning zero.
 *
 * So the setup screen refuses to be quiet about it, and these tests pin both halves.
 *
 * @package naulon
 */

class PermalinkGuardTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';

	/** @var int */
	private $post_id;

	public function set_up() {
		parent::set_up();
		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		$this->post_id = self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'a-post',
				'post_status' => 'publish',
			)
		);
	}

	public function tear_down() {
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	public function test_plain_permalinks_are_reported_as_not_ok() {
		update_option( 'permalink_structure', '' );
		$this->assertFalse( Naulon_Verification::permalinks_ok() );
	}

	public function test_any_structure_is_ok() {
		update_option( 'permalink_structure', '/%postname%/' );
		$this->assertTrue( Naulon_Verification::permalinks_ok() );
	}

	public function test_with_plain_permalinks_an_article_has_no_slug_to_be_paid_for() {
		update_option( 'permalink_structure', '' );

		$slug = Naulon_Credits::instance()->canonical_slug_for( get_post( $this->post_id ) );

		$this->assertSame( '', $slug, 'this is the silent failure the setup screen has to shout about' );
	}

	public function test_with_a_structure_the_slug_is_the_path_the_gate_derives() {
		update_option( 'permalink_structure', '/blog/%postname%/' );

		$this->assertSame( 'blog/a-post', Naulon_Credits::instance()->canonical_slug_for( get_post( $this->post_id ) ) );
	}

	public function test_the_setup_screen_says_so_before_anything_else() {
		update_option( 'permalink_structure', '' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );

		ob_start();
		Naulon_Admin_Setup::render();
		$html = ob_get_clean();

		$this->assertStringContainsString( 'notice-error', $html );
		$this->assertStringContainsString( 'Permalinks are set to Plain', $html );
	}

	public function test_the_setup_screen_hands_over_the_base_never_the_route_itself() {
		// The consumer appends /credits/<slug>. Showing the full route address makes it fetch
		// …/credits/credits/<slug>, which 404s on any site whose leaf lookup is ambiguous — and a
		// 404 here means "read this one free", silently.
		update_option( 'permalink_structure', '/%postname%/' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );

		ob_start();
		Naulon_Admin_Setup::render();
		$html = ob_get_clean();

		$base = Naulon_Credits::credits_base_url();
		$this->assertStringContainsString( 'value="' . esc_attr( $base ) . '"', $html );
		$this->assertStringNotContainsString( 'value="' . esc_attr( $base . '/credits/' ) . '"', $html );
	}

	public function test_the_base_has_no_trailing_slash_and_no_credits_segment() {
		// Pretty permalinks, because that is the only configuration where anything is tollable
		// at all — with plain ones rest_url() returns the ?rest_route= form and the plugin has
		// already refused to work (see the tests above).
		update_option( 'permalink_structure', '/%postname%/' );

		$base = Naulon_Credits::credits_base_url();

		$this->assertStringEndsWith( '/wp-json/naulon/v1', $base );
		$this->assertStringNotContainsString( '/credits', $base );
		$this->assertSame( rtrim( $base, '/' ), $base );
	}

	public function test_the_warning_is_gone_once_permalinks_are_set() {
		update_option( 'permalink_structure', '/%postname%/' );
		wp_set_current_user( self::factory()->user->create( array( 'role' => 'administrator' ) ) );

		ob_start();
		Naulon_Admin_Setup::render();
		$html = ob_get_clean();

		$this->assertStringNotContainsString( 'Permalinks are set to Plain', $html );
	}
}
