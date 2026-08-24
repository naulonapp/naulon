<?php
/**
 * Publishing the RSL licence.
 *
 * Two properties carry the weight here, and neither is about XML:
 *
 *   • **Nothing is advertised that is not served.** A `License:` line or a `<link rel="license">`
 *     pointing at a 404 tells a crawler the terms exist and then refuses to show them. So both
 *     pointers are silent until a document has actually been stored.
 *   • **A page render never makes a network call.** The document is refreshed from the heartbeat
 *     and, at most, by a request for `/license.xml` itself.
 *
 * @package naulon
 */

class LicenseTest extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		update_option( 'permalink_structure', '/blog/%postname%/' );
		Naulon_License::instance()->register();
	}

	public function tear_down() {
		update_option( 'permalink_structure', '' );
		delete_option( Naulon_License::OPTION );
		delete_transient( Naulon_License::RETRY_TRANSIENT );
		parent::tear_down();
	}

	/** Store a document without going near the network. */
	private function store_document( $xml = '<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"></rsl>' ) {
		update_option(
			Naulon_License::OPTION,
			array(
				'xml'        => $xml,
				'fetched_at' => time(),
			),
			false
		);
	}

	public function test_no_document_means_no_robots_line_and_no_link_tag() {
		$this->assertSame(
			"User-agent: *\n",
			Naulon_License::instance()->add_robots_line( "User-agent: *\n" ),
			'a License: line pointing at a 404 is worse than silence'
		);

		ob_start();
		Naulon_License::instance()->print_link_tag();
		$this->assertSame( '', ob_get_clean() );
	}

	public function test_a_stored_document_is_advertised_in_robots_and_in_the_head() {
		$this->store_document();

		$robots = Naulon_License::instance()->add_robots_line( "User-agent: *\nDisallow:\n" );
		$this->assertStringContainsString( 'License: ' . home_url( '/license.xml' ), $robots );
		$this->assertStringStartsWith( "User-agent: *\nDisallow:\n", $robots, 'the existing body must survive' );

		ob_start();
		Naulon_License::instance()->print_link_tag();
		$head = ob_get_clean();
		$this->assertStringContainsString( 'rel="license"', $head );
		$this->assertStringContainsString( 'type="application/rsl+xml"', $head );
		$this->assertStringContainsString( home_url( '/license.xml' ), $head );
	}

	public function test_reading_the_document_for_a_page_render_never_fetches() {
		// The default argument is the whole guard: `document()` may only reach the network when a
		// caller explicitly opts in, which is the licence route and nothing else.
		$http = 0;
		$count = function ( $preempt ) use ( &$http ) {
			$http++;
			return $preempt;
		};
		add_filter( 'pre_http_request', $count );

		Naulon_License::instance()->document();
		Naulon_License::instance()->print_link_tag();
		Naulon_License::instance()->add_robots_line( "User-agent: *\n" );

		remove_filter( 'pre_http_request', $count );
		$this->assertSame( 0, $http, 'a reader\'s page view must never wait on the control plane' );
	}

	public function test_the_licence_is_served_before_wordpress_canonicalizes_the_url() {
		// Same trap the ownership challenge fell into: from `template_redirect` a trailing-slash
		// permalink structure 301s `/license.xml`, and a crawler that does not follow it sees
		// no licence at all.
		$this->assertNotFalse(
			has_action( 'parse_request', array( Naulon_License::instance(), 'maybe_serve' ) )
		);
		$this->assertFalse(
			apply_filters( 'redirect_canonical', 'https://example.com/license.xml/', 'https://example.com/license.xml' )
		);
		$this->assertSame(
			'https://example.com/blog/post/',
			apply_filters( 'redirect_canonical', 'https://example.com/blog/post/', 'https://example.com/blog/post' ),
			'the guard must be scoped to the licence path'
		);
	}

	public function test_the_rewrite_rule_is_registered_at_the_top_and_matches_the_licence_path() {
		Naulon_License::instance()->add_rewrite_rules();
		$pattern = '^license\\.xml$';

		// Registered at 'top' so a page rule or an SEO plugin's catch-all cannot answer first.
		global $wp_rewrite;
		$extra = isset( $wp_rewrite->extra_rules_top ) ? $wp_rewrite->extra_rules_top : array();
		$this->assertArrayHasKey( $pattern, $extra, 'the licence rule must outrank page rules' );
		$this->assertStringContainsString( Naulon_License::QUERY_VAR, $extra[ $pattern ] );

		$this->assertSame( 1, preg_match( '#' . $pattern . '#', 'license.xml' ) );
		$this->assertSame( 0, preg_match( '#' . $pattern . '#', 'license.xml/extra' ), 'the rule is exact' );
	}

	public function test_a_failed_fetch_keeps_the_previous_document_and_backs_off() {
		$this->store_document( '<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"><!-- old --></rsl>' );
		// Age it past MAX_AGE so a refresh is due.
		update_option(
			Naulon_License::OPTION,
			array(
				'xml'        => '<?xml version="1.0"?><rsl xmlns="https://rslstandard.org/rsl"><!-- old --></rsl>',
				'fetched_at' => time() - ( Naulon_License::MAX_AGE + 60 ),
			),
			false
		);
		Naulon_Settings::update( array( 'api_key' => 'nln_live_test' ) );

		$fail = function () {
			return new WP_Error( 'http_request_failed', 'unreachable' );
		};
		add_filter( 'pre_http_request', $fail );
		$served = Naulon_License::instance()->document( true );
		remove_filter( 'pre_http_request', $fail );
		Naulon_Settings::update( array( 'api_key' => '' ) );

		$this->assertStringContainsString( '<!-- old -->', $served, 'stale terms are still the publisher\'s terms' );
		$this->assertNotFalse( get_transient( Naulon_License::RETRY_TRANSIENT ), 'a failure must back off' );
	}

	public function test_a_200_that_is_not_an_rsl_document_is_refused() {
		// The likely shape is a login or captcha page from something in front of the gate.
		Naulon_Settings::update( array( 'api_key' => 'nln_live_test' ) );
		$html = function () {
			return array(
				'headers'  => array(),
				'body'     => '<!doctype html><title>Sign in</title>',
				'response' => array( 'code' => 200, 'message' => 'OK' ),
				'cookies'  => array(),
			);
		};
		add_filter( 'pre_http_request', $html );
		$served = Naulon_License::instance()->document( true );
		remove_filter( 'pre_http_request', $html );
		Naulon_Settings::update( array( 'api_key' => '' ) );

		$this->assertSame( '', $served, 'serving a login page as our licensing terms is worse than serving none' );
	}

	public function test_a_site_with_no_key_publishes_nothing_and_calls_nothing() {
		Naulon_Settings::update( array( 'api_key' => '' ) );
		$http = 0;
		$count = function ( $preempt ) use ( &$http ) {
			$http++;
			return $preempt;
		};
		add_filter( 'pre_http_request', $count );
		$served = Naulon_License::instance()->document( true );
		remove_filter( 'pre_http_request', $count );

		$this->assertSame( '', $served );
		$this->assertSame( 0, $http, 'there is nothing to fetch with' );
	}
}
