<?php
/**
 * What a publisher is told when the setup key has already done its one job.
 *
 * The "Connect WordPress" preset mints `domain.manage`, and the control plane drops that scope
 * from the key the moment the domain verifies. That is the design: the plugin needs the write
 * exactly once, and what would otherwise sit in this site's options table for 30 days is a
 * credential that can re-claim domains.
 *
 * The consequence is that the SAME key answers 403 on any later claim — and both buttons on the
 * setup screen ("Start again", "Check now") stay on screen after success, so this is one click
 * away from a publisher who has just finished. It is also the state a host lands in after the
 * control plane's re-verify sweep demotes it: the fix is a fresh key, and no amount of editing
 * the old one will do.
 *
 * The message that used to render here — "Issue a key with the domain-management scope" — sent
 * them to a permission list that deliberately does not offer it. These tests pin that both 403s
 * name the preset instead, and that they differ: before verification the key was never right,
 * after verification it was right and is now spent.
 *
 * @package naulon
 */

class SpentSetupKeyTest extends WP_UnitTestCase {

	public function set_up() {
		parent::set_up();
		Naulon_Settings::update(
			array(
				'api_key'         => 'nln_live_test',
				'verified_at'     => '',
				'challenge_host'  => '',
				'challenge_token' => '',
			)
		);
		add_filter( 'pre_http_request', array( $this, 'forbid' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'forbid' ), 10 );
		Naulon_Settings::update(
			array(
				'verified_at'     => '',
				'challenge_host'  => '',
				'challenge_token' => '',
			)
		);
		parent::tear_down();
	}

	/**
	 * Every control-plane call answers 403 — a key without `domain.manage`.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  Target URL.
	 * @return array
	 */
	public function forbid( $pre, $args, $url ) {
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( array( 'error' => 'forbidden' ) ),
			'response' => array( 'code' => 403, 'message' => '' ),
		);
	}

	public function test_a_403_after_verification_names_a_fresh_preset_key() {
		Naulon_Settings::update( array( 'verified_at' => gmdate( 'c' ) ) );

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString(
			'Connect WordPress',
			$result['message'],
			'the preset is the only thing that mints this scope — the message has to name it'
		);
		$this->assertStringNotContainsString(
			'domain-management scope',
			$result['message'],
			'that phrase pointed at a permission the matrix does not offer'
		);
	}

	public function test_the_post_verification_403_does_not_read_as_a_setup_failure() {
		// The credential is spent because setup SUCCEEDED. A publisher one click past the finish
		// line must not be told their key is broken.
		Naulon_Settings::update( array( 'verified_at' => gmdate( 'c' ) ) );

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertStringContainsString( 'already verified', $result['message'] );
		$this->assertTrue(
			Naulon_Settings::is_verified(),
			'a refused re-claim must not un-verify a site that is verified — enforcement keeps running'
		);
	}

	public function test_a_403_before_verification_says_the_key_was_never_right() {
		$result = Naulon_Verification::start( 'well-known' );

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'Connect WordPress', $result['message'] );
		$this->assertStringContainsString(
			'read-only',
			$result['message'],
			'the common mistake is assembling a key from the permission list; say why it cannot work'
		);
	}

	public function test_the_check_leg_reports_the_same_thing() {
		// `complete()` reaches the same 403 through its own path — the "Check now" button. It must
		// not fall through to the bare "The control plane answered 403."
		Naulon_Settings::update( array( 'verified_at' => gmdate( 'c' ) ) );

		$result = Naulon_Verification::complete();

		$this->assertFalse( $result['ok'] );
		$this->assertStringContainsString( 'Connect WordPress', $result['message'] );
	}
}
