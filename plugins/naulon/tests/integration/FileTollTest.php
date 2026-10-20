<?php
/**
 * The file route, planned against real files in the uploads directory.
 *
 * Plans are asserted rather than responses because emit() exits. Task-level proof that the bytes
 * leave the server correctly is the real-Apache run in bin/, not this suite.
 *
 * @package naulon
 */

class FileTollTest extends WP_UnitTestCase {

	const WALLET = '0x1111111111111111111111111111111111111111';
	const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';
	const REL    = '2026/09/stage-toll.pdf';
	const BYTES  = "%PDF-1.4\n% naulon file toll test body\n%%EOF\n";

	/** @var string */
	private $basedir;

	/** @var array|null Canned quote, or null for an unreachable control plane. */
	private $quote;

	/** @var array|null Canned settle answer. */
	private $settle;

	public function set_up() {
		parent::set_up();
		$this->basedir = wp_upload_dir( null, false )['basedir'];
		wp_mkdir_p( $this->basedir . '/2026/09' );
		file_put_contents( $this->basedir . '/' . self::REL, self::BYTES ); // phpcs:ignore WordPress.WP.AlternativeFunctions

		$author = self::factory()->user->create( array( 'role' => 'author' ) );
		update_user_meta( $author, Naulon_Credits::USER_WALLET_META, self::WALLET );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array( 'pdf' ) );
		$parent = self::factory()->post->create(
			array(
				'post_author' => $author,
				'post_status' => 'publish',
			)
		);
		$id     = self::factory()->attachment->create_object( 'stage-toll.pdf', $parent, array( 'post_mime_type' => 'application/pdf' ) );
		update_attached_file( $id, self::REL );

		Naulon_Settings::update(
			array(
				'api_key'        => 'nln_live_' . str_repeat( 'a', 40 ),
				'api_base'       => 'https://api.example.test',
				'verified_at'    => '2026-07-27T00:00:00Z',
				'enforcement_on' => true,
			)
		);
		$this->quote  = array(
			'slug'   => 'wp-content/uploads/' . self::REL,
			'price'  => 5000,
			'payees' => array( array( 'address' => self::WALLET, 'shareBps' => 10000 ) ),
			'x402'   => array(
				'header' => 'x402-file-header',
				'legs'   => array( array( 'role' => 'author' ) ),
			),
		);
		$this->settle = null;
		add_filter( 'pre_http_request', array( $this, 'intercept' ), 10, 3 );
		$this->as( self::CHROME, 'text/html' );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'intercept' ), 10 );
		foreach ( array( 'HTTP_USER_AGENT', 'HTTP_ACCEPT', 'HTTP_RANGE', 'HTTP_PAYMENT_SIGNATURE', 'HTTP_X_NAULON_PROBE', 'HTTP_IF_NONE_MATCH' ) as $k ) {
			unset( $_SERVER[ $k ] );
		}
		delete_transient( 'naulon_402_' . md5( 'wp-content/uploads/' . self::REL . '|read' ) );
		delete_transient( Naulon_File_Probe::NONCE_TRANSIENT );
		delete_option( Naulon_Rules::FILE_TYPES_OPTION );
		Naulon_Rules::instance()->reset();
		Naulon_Enforcer::instance()->reset();
		parent::tear_down();
	}

	public function intercept( $pre, $args, $url ) {
		if ( false !== strpos( $url, '/_naulon/quote' ) && null !== $this->quote ) {
			return $this->json( 200, $this->quote );
		}
		if ( false !== strpos( $url, '/_naulon/verify' ) && null !== $this->settle ) {
			return $this->json( 200, $this->settle );
		}
		if ( null === $this->quote ) {
			return new WP_Error( 'http_request_failed', 'down' );
		}
		return $this->json( 404, array() );
	}

	private function json( $code, $body ) {
		return array(
			'headers'  => array(),
			'body'     => wp_json_encode( $body ),
			'response' => array( 'code' => $code, 'message' => '' ),
		);
	}

	private function as( $ua, $accept ) {
		$_SERVER['HTTP_USER_AGENT'] = $ua;
		$_SERVER['HTTP_ACCEPT']     = $accept;
	}

	private function plan( $rel = self::REL ) {
		Naulon_Enforcer::instance()->reset();
		return Naulon_File_Toll::instance()->plan( $rel );
	}

	private function header_value( array $plan, $name ) {
		foreach ( $plan['headers'] as $line ) {
			if ( 0 === stripos( $line, $name . ':' ) ) {
				return trim( substr( $line, strlen( $name ) + 1 ) );
			}
		}
		return null;
	}

	public function test_human_gets_file_bytes_no_store() {
		$plan = $this->plan();

		$this->assertSame( 200, $plan['status'] );
		$this->assertSame( realpath( $this->basedir . '/' . self::REL ), $plan['file'] );
		$this->assertSame( strlen( self::BYTES ), $plan['length'] );
		$this->assertSame( 'private, no-store', $this->header_value( $plan, 'Cache-Control' ) );
		$this->assertSame( 'User-Agent', $this->header_value( $plan, 'Vary' ) );
		$this->assertSame( 'application/pdf', $this->header_value( $plan, 'Content-Type' ) );
		$this->assertSame( (string) strlen( self::BYTES ), $this->header_value( $plan, 'Content-Length' ) );
		$this->assertNotNull( $this->header_value( $plan, 'ETag' ) );
	}

	public function test_agent_gets_402_with_payment_required() {
		$this->as( 'GPTBot/1.0', '*/*' );
		$plan = $this->plan();

		$this->assertSame( 402, $plan['status'] );
		$this->assertSame( 'x402-file-header', $this->header_value( $plan, 'PAYMENT-REQUIRED' ) );
		$this->assertSame( 'private, no-store', $this->header_value( $plan, 'Cache-Control' ) );
		$this->assertStringContainsString( 'stage-toll.pdf', $plan['body'] );
		$this->assertArrayNotHasKey( 'file', $plan );
	}

	public function test_paid_agent_gets_file_receipt_license() {
		$this->as( 'GPTBot/1.0', '*/*' );
		$_SERVER['HTTP_PAYMENT_SIGNATURE'] = 'signed-payment';
		$this->settle                      = array(
			'ok'             => true,
			'settlementRef'  => 'ref-1',
			'payer'          => '0x3333333333333333333333333333333333333333',
			'responseHeader' => 'receipt-bytes',
			'licenseJws'     => 'license-jws',
		);
		$plan = $this->plan();

		$this->assertSame( 200, $plan['status'] );
		$this->assertSame( 'receipt-bytes', $this->header_value( $plan, 'PAYMENT-RESPONSE' ) );
		$this->assertSame( 'license-jws', $this->header_value( $plan, 'X-Naulon-License' ) );
		$this->assertArrayHasKey( 'file', $plan );
	}

	public function test_range_request_returns_206() {
		$_SERVER['HTTP_RANGE'] = 'bytes=0-9';
		$plan                  = $this->plan();

		$this->assertSame( 206, $plan['status'] );
		$this->assertSame( 0, $plan['offset'] );
		$this->assertSame( 10, $plan['length'] );
		$this->assertSame( 'bytes 0-9/' . strlen( self::BYTES ), $this->header_value( $plan, 'Content-Range' ) );
	}

	public function test_open_and_suffix_ranges() {
		$size = strlen( self::BYTES );
		$this->assertSame( array( 5, $size - 1 ), Naulon_File_Toll::parse_range( 'bytes=5-', $size ) );
		$this->assertSame( array( $size - 4, $size - 1 ), Naulon_File_Toll::parse_range( 'bytes=-4', $size ) );
		$this->assertFalse( Naulon_File_Toll::parse_range( 'bytes=' . $size . '-', $size ) );
		$this->assertNull( Naulon_File_Toll::parse_range( 'bytes=0-1,4-5', $size ) );
	}

	public function test_unsatisfiable_range_is_416() {
		$_SERVER['HTTP_RANGE'] = 'bytes=999999-';
		$this->assertSame( 416, $this->plan()['status'] );
	}

	public function test_matching_etag_is_304() {
		$_SERVER['HTTP_IF_NONE_MATCH'] = $this->header_value( $this->plan(), 'ETag' );
		$this->assertSame( 304, $this->plan()['status'] );
	}

	public function test_traversal_is_404() {
		$this->assertSame( 404, $this->plan( '../../wp-config.php' )['status'] );
		$this->assertSame( 404, $this->plan( '%2e%2e/%2e%2e/wp-config.php' )['status'] );
		$this->assertSame( 404, $this->plan( "2026/09/stage-toll.pdf\0.php" )['status'] );
	}

	public function test_symlink_out_of_uploads_is_404() {
		$link = $this->basedir . '/2026/09/escape.pdf';
		@unlink( $link ); // phpcs:ignore
		symlink( ABSPATH . 'wp-config-sample.php', $link );
		$this->assertSame( 404, $this->plan( '2026/09/escape.pdf' )['status'] );
		unlink( $link ); // phpcs:ignore
	}

	public function test_a_php_file_in_uploads_is_never_served() {
		file_put_contents( $this->basedir . '/2026/09/shell.php', '<?php echo 1;' ); // phpcs:ignore
		$this->assertSame( 404, $this->plan( '2026/09/shell.php' )['status'] );
		unlink( $this->basedir . '/2026/09/shell.php' ); // phpcs:ignore
	}

	public function test_unknown_file_is_404() {
		$this->assertSame( 404, $this->plan( '2026/09/missing.pdf' )['status'] );
	}

	public function test_control_plane_down_serves_file() {
		$this->as( 'GPTBot/1.0', '*/*' );
		$this->quote = null;
		$plan        = $this->plan();

		$this->assertSame( 200, $plan['status'] );
		$this->assertArrayHasKey( 'file', $plan );
	}

	public function test_type_not_opted_in_is_served_free_to_an_agent() {
		$this->as( 'GPTBot/1.0', '*/*' );
		update_option( Naulon_Rules::FILE_TYPES_OPTION, array() );
		$this->assertSame( 200, $this->plan()['status'] );
	}

	public function test_probe_echoes_nonce() {
		wp_mkdir_p( $this->basedir . '/' . Naulon_File_Probe::DIR );
		file_put_contents( $this->basedir . '/' . Naulon_File_Probe::DIR . '/' . Naulon_File_Probe::FILE, self::BYTES ); // phpcs:ignore
		$nonce = Naulon_File_Probe::instance()->issue_nonce();

		$_SERVER['HTTP_X_NAULON_PROBE'] = $nonce;
		$plan                           = $this->plan( Naulon_File_Probe::DIR . '/' . Naulon_File_Probe::FILE );
		$this->assertSame( 'routed; n=' . $nonce, $this->header_value( $plan, 'X-Naulon-File' ) );

		$_SERVER['HTTP_X_NAULON_PROBE'] = 'not-a-nonce';
		$plan                           = $this->plan( Naulon_File_Probe::DIR . '/' . Naulon_File_Probe::FILE );
		$this->assertNull( $this->header_value( $plan, 'X-Naulon-File' ) );
	}
}
