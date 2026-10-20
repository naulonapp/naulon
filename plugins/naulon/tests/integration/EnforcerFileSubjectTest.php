<?php
/**
 * A file goes through the article's decision path, priced under its own slug and URL.
 *
 * @package naulon
 */

class EnforcerFileSubjectTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';
	const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
	const SLUG   = 'wp-content/uploads/2026/09/stage-toll.pdf';

	/** @var string[] Every outbound URL except the rules fetch. */
	private $urls = array();

	/** @var int */
	private $attachment;

	public function set_up() {
		parent::set_up();
		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		update_option( 'permalink_structure', '/%postname%/' );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'pdf' ) );

		$parent           = self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_name'   => 'the-paper',
				'post_status' => 'publish',
			)
		);
		$this->attachment = self::factory()->attachment->create_object( 'stage-toll.pdf', $parent, array( 'post_mime_type' => 'application/pdf' ) );
		update_attached_file( $this->attachment, '2026/09/stage-toll.pdf' );

		Naulon_Settings::update(
			array(
				'api_key'        => 'nln_live_' . str_repeat( 'a', 40 ),
				'api_base'       => 'https://api.example.test',
				'verified_at'    => '2026-07-27T00:00:00Z',
				'enforcement_on' => true,
			)
		);
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		Naulon_Enforcer::instance()->reset();
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		unset( $_SERVER['HTTP_USER_AGENT'], $_SERVER['HTTP_ACCEPT'] );
		delete_transient( 'naulon_402_' . md5( self::SLUG . '|read' ) );
		delete_option( Naulon_Rules::FILE_TYPES_OPTION );
		Naulon_Rules::instance()->reset();
		Naulon_Enforcer::instance()->reset();
		update_option( 'permalink_structure', '' );
		parent::tear_down();
	}

	public function intercept( $pre, $args, $url ) {
		if ( false === strpos( $url, '/_naulon/enforce-config' ) ) {
			$this->urls[] = $url;
		}
		if ( false !== strpos( $url, '/_naulon/quote' ) ) {
			return array(
				'headers'  => array(),
				'body'     => wp_json_encode(
					array(
						'slug'   => self::SLUG,
						'price'  => 5000,
						'payees' => array( array( 'address' => self::WALLET, 'shareBps' => 10000 ) ),
						'x402'   => array(
							'header' => 'x402-file-header',
							'legs'   => array( array( 'role' => 'author' ) ),
						),
					)
				),
				'response' => array( 'code' => 200, 'message' => '' ),
			);
		}
		return array(
			'headers'  => array(),
			'body'     => '',
			'response' => array( 'code' => 404, 'message' => '' ),
		);
	}

	private function decide() {
		Naulon_Enforcer::instance()->reset();
		$file = Naulon_Credits::instance()->resolve_file( self::SLUG );
		$this->assertNotNull( $file );
		return Naulon_Enforcer::instance()->decide_subject( Naulon_Toll_Subject::for_file( $file ) );
	}

	public function test_file_subject_agent_gets_pay_decision() {
		$_SERVER['HTTP_USER_AGENT'] = 'GPTBot/1.0';
		$_SERVER['HTTP_ACCEPT']     = '*/*';

		$decision = $this->decide();

		$this->assertSame( 'pay', $decision['action'] );
		$this->assertSame( 'x402-file-header', $decision['header'] );
		$quotes = array_values(
			array_filter(
				$this->urls,
				function ( $u ) {
					return false !== strpos( $u, '/_naulon/quote' );
				}
			)
		);
		$this->assertCount( 1, $quotes );
		parse_str( (string) wp_parse_url( $quotes[0], PHP_URL_QUERY ), $q );
		$this->assertSame( self::SLUG, $q['slug'] );
		$this->assertStringEndsWith( '/' . self::SLUG, $q['resource'] );
	}

	public function test_file_subject_human_is_free_without_network() {
		$_SERVER['HTTP_USER_AGENT'] = self::CHROME;
		$_SERVER['HTTP_ACCEPT']     = 'text/html,application/xhtml+xml';

		$this->assertSame( 'free', $this->decide()['action'] );
		$this->assertSame( array(), $this->urls );
	}

	public function test_file_on_free_post_is_free_for_an_agent() {
		$_SERVER['HTTP_USER_AGENT'] = 'GPTBot/1.0';
		$_SERVER['HTTP_ACCEPT']     = '*/*';
		update_post_meta( wp_get_post_parent_id( $this->attachment ), Naulon_Credits::POST_TOLL_META, 'free' );

		$this->assertSame( 'free', $this->decide()['action'] );
	}
}
