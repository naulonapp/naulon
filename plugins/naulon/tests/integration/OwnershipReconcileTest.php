<?php
/**
 * The plugin has to notice when the control plane withdraws its ownership proof.
 *
 * The enforcer gates on the LOCAL `verified_at`, and nothing ever re-read it. But the control
 * plane can demote on its own: its re-verify sweep gives up on a host that stops serving the
 * challenge for longer than the grace window — triggered by the exact failure this plugin's own
 * diagnostics call the common one, a security or static-file plugin swallowing `/.well-known/` —
 * and removing the domain in the dashboard does the same thing.
 *
 * The state that left behind: the control plane answers `resource not owned by this key`, so no
 * payment can settle, while this plugin keeps issuing 402s. Agents loop pay → rejected, the site
 * earns nothing, and wp-admin shows a green Verified pill over all of it.
 *
 * These tests pin the reconciliation, and pin just as hard that it only fires on an authoritative
 * answer — un-verifying a healthy site because the network hiccuped would take a working toll
 * offline, which is a worse failure than the one being fixed.
 *
 * @package naulon
 */

class OwnershipReconcileTest extends WP_UnitTestCase {

	/** @var array Body for the next intercepted request. */
	private $body = array();

	/** @var int Status for the next intercepted request. */
	private $status = 200;

	/** @var bool When true, every request fails at the transport. */
	private $transport_error = false;

	public function set_up() {
		parent::set_up();
		Naulon_Settings::update(
			array(
				'api_key'           => 'nln_live_test',
				'verified_at'       => gmdate( 'c' ),
				'ownership_lost_at' => '',
			)
		);
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		Naulon_Settings::update(
			array(
				'verified_at'       => '',
				'ownership_lost_at' => '',
			)
		);
		parent::tear_down();
	}

	/**
	 * Stand in for `GET /_naulon/verify-host`.
	 *
	 * @param mixed  $pre  Short-circuit value.
	 * @param array  $args Request args.
	 * @param string $url  Target URL.
	 * @return array|WP_Error
	 */
	public function intercept( $pre, $args, $url ) {
		if ( $this->transport_error ) {
			return new WP_Error( 'http_request_failed', 'connection reset' );
		}
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $this->body ),
			'response' => array( 'code' => $this->status, 'message' => '' ),
		);
	}

	/** The list shape the control plane returns for this site's own host. */
	private function challenges( $verified_at ) {
		return array(
			'challenges' => array(
				array(
					'host'       => Naulon_Verification::host(),
					'verifiedAt' => $verified_at,
					'method'     => 'well-known',
				),
			),
		);
	}

	public function test_a_withdrawn_proof_clears_the_local_verification() {
		$this->body = $this->challenges( null );

		$cleared = Naulon_Cron::instance()->reconcile_ownership();

		$this->assertTrue( $cleared );
		$this->assertFalse(
			Naulon_Settings::is_verified(),
			'the enforcer gates on this — leaving it set is what kept the unsettleable 402s flowing'
		);
		$settings = Naulon_Settings::all();
		$this->assertNotSame(
			'',
			trim( (string) $settings['ownership_lost_at'] ),
			'"lost it" and "never had it" need different words on the setup screen'
		);
	}

	public function test_a_host_missing_from_the_list_is_also_a_withdrawal() {
		// What a domain deleted in the dashboard looks like: the challenge row is gone.
		$this->body = array( 'challenges' => array( array( 'host' => 'someone-else.example', 'verifiedAt' => '2026-01-01T00:00:00Z' ) ) );

		$this->assertTrue( Naulon_Cron::instance()->reconcile_ownership() );
		$this->assertFalse( Naulon_Settings::is_verified() );
	}

	public function test_a_still_verified_host_is_left_alone() {
		$this->body = $this->challenges( '2026-07-01T00:00:00Z' );

		$this->assertFalse( Naulon_Cron::instance()->reconcile_ownership(), 'the common path changes nothing' );
		$this->assertTrue( Naulon_Settings::is_verified() );
		$this->assertSame( '', trim( (string) Naulon_Settings::all()['ownership_lost_at'] ) );
	}

	public function test_a_transport_failure_never_un_verifies() {
		$this->transport_error = true;

		$this->assertFalse( Naulon_Cron::instance()->reconcile_ownership() );
		$this->assertTrue(
			Naulon_Settings::is_verified(),
			'taking a working toll offline because the network hiccuped is worse than the bug this fixes'
		);
	}

	public function test_a_401_never_un_verifies() {
		// A revoked or mistyped key is loud elsewhere; it is not evidence about ownership.
		$this->status = 401;
		$this->body   = array( 'error' => 'unauthorized' );

		$this->assertFalse( Naulon_Cron::instance()->reconcile_ownership() );
		$this->assertTrue( Naulon_Settings::is_verified() );
	}

	public function test_a_malformed_body_never_un_verifies() {
		$this->body = array( 'nonsense' => true );

		$this->assertFalse( Naulon_Cron::instance()->reconcile_ownership() );
		$this->assertTrue( Naulon_Settings::is_verified() );
	}

	public function test_an_unverified_site_makes_no_call_at_all() {
		// Nothing to withdraw, so this must not spend a request on every tick.
		Naulon_Settings::update( array( 'verified_at' => '' ) );
		$this->transport_error = true; // would be visible as an exception path if it called out

		$this->assertFalse( Naulon_Cron::instance()->reconcile_ownership() );
	}

	public function test_re_verifying_clears_the_lost_marker() {
		Naulon_Settings::update( array( 'verified_at' => '', 'ownership_lost_at' => gmdate( 'c' ) ) );
		$this->body = array( 'verified' => true, 'host' => Naulon_Verification::host() );

		$result = Naulon_Verification::complete();

		$this->assertTrue( $result['ok'] );
		$this->assertSame(
			'',
			trim( (string) Naulon_Settings::all()['ownership_lost_at'] ),
			'a recovered site must stop being told it lost its proof'
		);
	}
}
