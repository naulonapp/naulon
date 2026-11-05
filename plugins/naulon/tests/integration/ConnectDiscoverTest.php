<?php
/**
 * What a site is told when it asks a gate whether it offers Connect.
 *
 * The answer decides the sentence on the Setup screen, so each status gets its own: a 404 is what
 * a real gate with Connect switched off returns, and calling that "not a naulon gate" sends the
 * publisher to check an address that was right.
 *
 * @package naulon
 */

class ConnectDiscoverTest extends WP_UnitTestCase {

	const GATE = 'https://gate.example.com';

	/** @var array{0:int,1:string}|null */
	private $answer = null;

	/** @var string[] */
	private $asked = array();

	public function set_up() {
		parent::set_up();
		add_filter( 'pre_http_request', array( $this, 'gate' ), 10, 3 );
	}

	public function tear_down() {
		remove_filter( 'pre_http_request', array( $this, 'gate' ), 10 );
		parent::tear_down();
	}

	/**
	 * Stands in for the gate.
	 *
	 * @param mixed  $pre  Unused.
	 * @param array  $args Unused.
	 * @param string $url  The URL asked for.
	 * @return array
	 */
	public function gate( $pre, $args, $url ) {
		$this->asked[] = $url;
		return array(
			'headers'  => array(),
			'body'     => $this->answer[1],
			'response' => array(
				'code'    => $this->answer[0],
				'message' => '',
			),
			'cookies'  => array(),
		);
	}

	/**
	 * The first well-formed discovery document in the cross-runtime fixture.
	 *
	 * @return array
	 */
	private static function valid_document() {
		$cases = json_decode( (string) file_get_contents( dirname( __DIR__, 4 ) . '/packages/shared/test-fixtures/connect-cases.json' ), true );
		foreach ( $cases['discovery'] as $case ) {
			if ( true === $case['ok'] && self::GATE === $case['gate'] ) {
				return $case['body'];
			}
		}
		self::fail( 'connect-cases.json has no well-formed document for ' . self::GATE );
	}

	public function test_a_gate_with_connect_off_is_not_called_a_non_gate() {
		$this->answer = array( 404, 'Not Found' );
		$said         = Naulon_Connect::discover( self::GATE );

		$this->assertIsString( $said );
		$this->assertStringContainsString( 'does not offer Connect', $said );
		$this->assertStringNotContainsString( 'not a naulon gate', $said );
		$this->assertSame( array( self::GATE . Naulon_Connect_Protocol::DISCOVERY_PATH ), $this->asked );
	}

	public function test_any_other_failure_names_the_status() {
		$this->answer = array( 502, 'Bad Gateway' );
		$said         = Naulon_Connect::discover( self::GATE );

		$this->assertIsString( $said );
		$this->assertStringContainsString( 'answered 502', $said );
	}

	public function test_a_document_that_is_not_the_protocol_is_refused() {
		$this->answer = array( 200, '{"hello":"world"}' );
		$said         = Naulon_Connect::discover( self::GATE );

		$this->assertIsString( $said );
		$this->assertStringContainsString( 'is not a naulon gate:', $said );
	}

	public function test_a_well_formed_document_is_returned() {
		$this->answer = array( 200, wp_json_encode( self::valid_document() ) );
		$doc          = Naulon_Connect::discover( self::GATE . '/' );

		$this->assertIsArray( $doc );
	}
}
