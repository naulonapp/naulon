<?php
/**
 * Inviting an author from a site connected through Connect.
 *
 * A connect credential carries site.enforce and nothing else, so the site cannot ask naulon to
 * send mail. The invitation is sent on naulon by a person signed in there, from a link that names
 * this site's host and the author. The link's origin comes from the gate's discovery document,
 * never from a constant in this plugin.
 *
 * @package naulon
 */

class ConnectInviteTest extends WP_UnitTestCase {

	const GATE       = 'https://gate.example.com';
	const CREDENTIAL = 'nln_site_0123456789abcdefghijABCDEFGHIJ0123456789xyz';

	/** @var int */
	private $calls = 0;

	public function set_up() {
		parent::set_up();
		add_filter( 'pre_http_request', array( $this, 'gate' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'gate' ), 10 );
		delete_transient( 'naulon_portal_' . md5( self::GATE ) );
		Naulon_Settings::update( array( 'api_key' => '' ) );
		parent::tear_down();
	}

	/**
	 * A gate whose approval page is on another origin, as the hosted one's is.
	 *
	 * @return array
	 */
	public function gate() {
		++$this->calls;
		$doc                           = json_decode( (string) file_get_contents( dirname( __DIR__, 4 ) . '/packages/shared/test-fixtures/connect-cases.json' ), true )['discovery'][0]['body'];
		$doc['authorization_endpoint'] = 'https://portal.example.com/connect/authorize';
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $doc ),
			'response' => array(
				'code'    => 200,
				'message' => 'OK',
			),
			'cookies'  => array(),
		);
	}

	public function test_the_link_opens_the_portal_the_gate_names_with_the_author_filled_in() {
		$url = Naulon_Connect::invite_url( self::GATE, 'ada+writer@example.com', 'wp-user-7' );

		$this->assertIsString( $url );
		$this->assertStringStartsWith( 'https://portal.example.com/dashboard/settings?', $url );
		$this->assertStringEndsWith( '#team', $url );
		parse_str( (string) wp_parse_url( $url, PHP_URL_QUERY ), $q );
		$this->assertSame( strtolower( (string) wp_parse_url( home_url( '/' ), PHP_URL_HOST ) ), $q['inviteHost'] );
		$this->assertSame( 'ada+writer@example.com', $q['inviteEmail'] );
		$this->assertSame( 'wp-user-7', $q['inviteAuthor'] );
	}

	public function test_the_portal_origin_is_asked_once_a_day_not_per_row() {
		Naulon_Connect::invite_url( self::GATE, 'a@example.com', 'wp-user-1' );
		Naulon_Connect::invite_url( self::GATE, 'b@example.com', 'wp-user-2' );

		$this->assertSame( 1, $this->calls );
	}

	public function test_approving_in_place_is_refused_with_the_way_through() {
		$this->assertTrue( Naulon_Connect_Protocol::is_site_credential( self::CREDENTIAL ) );
		Naulon_Settings::update( array( 'api_key' => self::CREDENTIAL ) );
		$author = self::factory()->user->create( array( 'role' => 'author', 'user_email' => 'w@example.com' ) );
		$admin  = self::factory()->user->create( array( 'role' => 'administrator', 'user_email' => 'a@example.com' ) );
		Naulon_Access::request( $author );

		$said = Naulon_Access::approve( $author, $admin );

		$this->assertIsString( $said );
		$this->assertStringContainsString( 'Approve on naulon', $said );
		$this->assertSame( 0, $this->calls, 'nothing was sent to naulon' );
		$this->assertSame( Naulon_Access::STATE_REQUESTED, Naulon_Access::state( $author ) );
	}
}
