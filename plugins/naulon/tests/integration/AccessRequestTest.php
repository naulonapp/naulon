<?php
/**
 * The access-request state machine. Pure meta transitions — the fleet call is `approve()`'s and is
 * exercised by the integration suite, not here.
 *
 * @package naulon
 */

class AccessRequestTest extends WP_UnitTestCase {

	public function test_the_payee_id_is_the_same_string_the_credits_endpoint_emits() {
		$user = self::factory()->user->create( array( 'role' => 'author' ) );
		$post = self::factory()->post->create( array( 'post_author' => $user, 'post_status' => 'publish' ) );

		$contributors = Naulon_Credits::instance()->contributors_for( get_post( $post ) );
		$this->assertSame( $contributors[0]['authorId'], Naulon_Access::author_id( $user ) );
	}

	public function test_a_fresh_user_has_no_request() {
		$user = self::factory()->user->create( array( 'role' => 'author' ) );
		$this->assertSame( '', Naulon_Access::state( $user ) );
	}

	public function test_requesting_records_it_once_and_asking_again_does_not_reset_the_clock() {
		$user = self::factory()->user->create( array( 'role' => 'author' ) );
		Naulon_Access::request( $user );
		$first = (int) get_user_meta( $user, Naulon_Access::REQUESTED_META, true );
		$this->assertSame( Naulon_Access::STATE_REQUESTED, Naulon_Access::state( $user ) );

		Naulon_Access::request( $user );
		$this->assertSame( $first, (int) get_user_meta( $user, Naulon_Access::REQUESTED_META, true ) );
	}

	public function test_clearing_removes_both_keys_so_nothing_records_a_refusal() {
		$user = self::factory()->user->create( array( 'role' => 'author' ) );
		Naulon_Access::request( $user );
		Naulon_Access::clear( $user );

		$this->assertSame( '', Naulon_Access::state( $user ) );
		$this->assertSame( '', (string) get_user_meta( $user, Naulon_Access::REQUESTED_META, true ) );
	}

	public function test_approving_an_unconnected_site_refuses_and_leaves_the_request_standing() {
		Naulon_Settings::update( array( 'api_key' => '' ) );
		$user  = self::factory()->user->create( array( 'role' => 'author' ) );
		$admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		Naulon_Access::request( $user );

		$error = Naulon_Access::approve( $user, $admin );
		$this->assertNotNull( $error );
		$this->assertSame(
			Naulon_Access::STATE_REQUESTED,
			Naulon_Access::state( $user ),
			'a refused approval must not consume the request'
		);
	}
	public function test_a_gate_connected_site_is_told_what_is_missing_not_sent_back_to_setup() {
		// Connecting a gate URL clears the API key by design, so Setup reports "Connected" while
		// approval cannot work. The refusal must name the key, not send the publisher to a screen
		// that already says it is finished.
		$user  = self::factory()->user->create( array( 'role' => 'author' ) );
		$admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		Naulon_Settings::update( array( 'gate_url' => 'https://gate.example', 'api_key' => '' ) );

		$msg = Naulon_Access::approve( $user, $admin );

		$this->assertNotNull( $msg, 'approval is refused without a key' );
		$this->assertStringNotContainsString( 'Finish Setup', $msg, 'Setup is already finished for this publisher' );
		$this->assertStringContainsString( 'API key', $msg );
	}

	public function test_an_unconnected_site_is_still_sent_to_setup() {
		$user  = self::factory()->user->create( array( 'role' => 'author' ) );
		$admin = self::factory()->user->create( array( 'role' => 'administrator' ) );
		Naulon_Settings::update( array( 'gate_url' => '', 'api_key' => '' ) );

		$msg = Naulon_Access::approve( $user, $admin );

		$this->assertStringContainsString( 'Finish Setup', $msg );
	}

}
