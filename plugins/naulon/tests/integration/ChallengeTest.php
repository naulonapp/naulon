<?php
/**
 * The ownership challenge surface.
 *
 * The first test in this file is a regression guard for a blocker found only by running real
 * WordPress: served from `template_redirect`, the challenge URL was answered by WordPress's
 * canonical redirect with a 301 adding a trailing slash. The control plane never follows a
 * 3xx, so verification could never pass on any site with trailing-slash permalinks — which is
 * the default. Both halves of the fix are pinned here: the hook now runs on `parse_request`,
 * and the canonical redirect is refused for this path.
 *
 * @package naulon
 */

class ChallengeTest extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		update_option( 'permalink_structure', '/blog/%postname%/' );
		Naulon_Challenge::instance()->register();
	}

	public function tear_down() {
		update_option( 'permalink_structure', '' );
		Naulon_Settings::update(
			array(
				'challenge_token' => '',
				'verified_at'     => '',
			)
		);
		parent::tear_down();
	}

	public function test_the_challenge_is_served_from_parse_request_not_template_redirect() {
		// template_redirect runs AFTER redirect_canonical, so serving there loses to a 301.
		$this->assertNotFalse(
			has_action( 'parse_request', array( Naulon_Challenge::instance(), 'maybe_serve' ) ),
			'the challenge must be served before WordPress canonicalizes the URL'
		);
	}

	public function test_wordpress_may_not_canonical_redirect_a_challenge_url() {
		$requested = 'https://example.com/.well-known/naulon-challenge/tok123';
		$wanted    = 'https://example.com/.well-known/naulon-challenge/tok123/';

		$this->assertFalse(
			apply_filters( 'redirect_canonical', $wanted, $requested ),
			'a 3xx on the challenge URL is indistinguishable from a missing challenge to the checker'
		);
	}

	public function test_other_urls_still_canonical_redirect_normally() {
		$this->assertSame(
			'https://example.com/blog/post/',
			apply_filters( 'redirect_canonical', 'https://example.com/blog/post/', 'https://example.com/blog/post' ),
			'the guard must be scoped to the challenge path, not disable canonicalization sitewide'
		);
	}

	public function test_the_rewrite_rule_is_registered_and_matches_with_or_without_a_trailing_slash() {
		Naulon_Challenge::instance()->add_rewrite_rules();
		$rules = get_option( 'rewrite_rules' );
		if ( ! is_array( $rules ) ) {
			$rules = array();
		}
		$pattern = '^\.well-known/naulon-challenge/([^/]+)/?$';

		// The rule may live in the option (flushed) or in the in-memory rewrite object.
		global $wp_rewrite;
		$extra = isset( $wp_rewrite->extra_rules_top ) ? $wp_rewrite->extra_rules_top : array();

		$this->assertTrue(
			isset( $rules[ $pattern ] ) || isset( $extra[ $pattern ] ),
			'the .well-known rewrite must be registered'
		);
		$this->assertSame( 1, preg_match( '#' . $pattern . '#', '.well-known/naulon-challenge/tok123' ) );
		$this->assertSame( 1, preg_match( '#' . $pattern . '#', '.well-known/naulon-challenge/tok123/' ) );
	}

	public function test_the_meta_tag_is_printed_while_a_challenge_is_open() {
		Naulon_Settings::update( array( 'challenge_token' => 'tok123', 'verified_at' => '' ) );

		ob_start();
		Naulon_Challenge::instance()->print_meta_tag();
		$html = ob_get_clean();

		$this->assertStringContainsString( 'name="naulon-site-verification"', $html );
		$this->assertStringContainsString( 'content="tok123"', $html );
	}

	public function test_the_meta_tag_disappears_once_ownership_is_stamped() {
		// Nothing is gained by advertising the token forever, and it is one less thing to leak.
		Naulon_Settings::update( array( 'challenge_token' => 'tok123', 'verified_at' => '2026-07-27T00:00:00Z' ) );

		ob_start();
		Naulon_Challenge::instance()->print_meta_tag();
		$this->assertSame( '', ob_get_clean() );
	}

	public function test_no_meta_tag_when_no_challenge_is_open() {
		Naulon_Settings::update( array( 'challenge_token' => '', 'verified_at' => '' ) );

		ob_start();
		Naulon_Challenge::instance()->print_meta_tag();
		$this->assertSame( '', ob_get_clean() );
	}

	public function test_the_challenge_url_is_absolute_and_url_encoded() {
		$url = Naulon_Challenge::challenge_url( 'tok/123' );
		$this->assertStringStartsWith( home_url(), $url );
		$this->assertStringContainsString( '/.well-known/naulon-challenge/tok%2F123', $url );
	}
}
