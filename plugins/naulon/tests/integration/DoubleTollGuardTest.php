<?php
/**
 * The double-toll guard.
 *
 * `POST /_naulon/verify-host` answers 409 `host_already_added` for ANY host that is already
 * verified — regardless of which proof made it live. Two very different situations share that
 * status and that code:
 *
 *   • verified for in-app       — nothing is tolling the host; a re-run of setup is a no-op.
 *   • verified AND fleet-routed — the domain CNAMEs to the naulon fleet, the fleet is collecting
 *                                 the toll RIGHT NOW, and enforcing here too would put our 402
 *                                 behind theirs. The agent pays twice for one read.
 *
 * This plugin used to read the 409 as plain success in both cases and stamp `verified_at`, which
 * is what the enforcer gates on — so installing the plugin on a fleet-routed domain armed the
 * double toll. `routingVerified` on the 409 body is what makes the two decidable; these tests pin
 * that the dangerous one leaves enforcement OFF.
 *
 * @package naulon
 */

class DoubleTollGuardTest extends WP_UnitTestCase {

	/** @var array The canned 409 body for the next open_challenge call. */
	private $body = array();

	/** @var int Status for the next intercepted request. */
	private $status = 409;

	public function set_up() {
		parent::set_up();
		Naulon_Settings::update(
			array(
				'api_key'        => 'nln_live_test',
				'verified_at'    => '',
				'challenge_host' => '',
			)
		);
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		Naulon_Settings::update(
			array(
				'verified_at'    => '',
				'challenge_host' => '',
			)
		);
		parent::tear_down();
	}

	/**
	 * Stand in for the control plane's verify-host route.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  Target URL.
	 * @return array
	 */
	public function intercept( $pre, $args, $url ) {
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $this->body ),
			'response' => array( 'code' => $this->status, 'message' => '' ),
		);
	}

	public function test_a_fleet_routed_409_is_refused_and_leaves_enforcement_off() {
		$this->body = array( 'error' => 'host_already_added', 'routingVerified' => true );

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertFalse( $result['ok'], 'a fleet-routed host must not report setup as done' );
		$this->assertFalse(
			Naulon_Settings::is_verified(),
			'verified_at must stay empty — the enforcer gates on it, so this is what keeps the second toll off'
		);
		$this->assertStringContainsString(
			'CNAME',
			$result['message'],
			'the refusal has to name the thing to remove, or the publisher is stuck with no next step'
		);
	}

	public function test_an_in_app_409_still_completes_setup() {
		// The benign case must not regress into a refusal: a publisher who already proved this host
		// for in-app and re-runs setup is simply done.
		$this->body = array( 'error' => 'host_already_added', 'routingVerified' => false );

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertTrue( $result['ok'], 'an in-app-verified host is done, not blocked' );
		$this->assertTrue( Naulon_Settings::is_verified(), 'verified_at is stamped so enforcement can run' );
	}

	public function test_a_409_with_no_routingVerified_is_refused() {
		// An older control plane sends the bare {error} this branch used to read as success — which
		// is precisely the ambiguity that armed the double toll. Absent means unknown, and the safe
		// read of unknown is "something may already be tolling this host".
		$this->body = array( 'error' => 'host_already_added' );

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertFalse( $result['ok'], 'an undecidable 409 must not be read as success' );
		$this->assertFalse( Naulon_Settings::is_verified(), 'enforcement stays off when the state is unknown' );
	}

	public function test_a_normal_challenge_open_is_untouched_by_the_guard() {
		// The guard is scoped to the 409; a 201 still stores the token and does NOT claim verified.
		$this->status = 201;
		$this->body   = array(
			'challenge' => array(
				'host'         => 'example.org',
				'token'        => 'tok-abc',
				'method'       => 'well-known',
				'verifiedAt'   => null,
				'capability'   => 'code',
				'codeArtifact' => 'wordpress_plugin',
			),
		);

		$result = Naulon_Verification::start( 'well-known' );

		$this->assertTrue( $result['ok'] );
		$this->assertSame( 'tok-abc', $result['token'] );
		$this->assertFalse( Naulon_Settings::is_verified(), 'opening a challenge is not proving it' );
	}
}
