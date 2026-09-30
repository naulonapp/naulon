<?php
/**
 * The pure half of Naulon_Fleet_Pull: parsing and the sodium crypto check, exercised against a
 * resolved directory and a fixed clock so nothing here touches WordPress or the network.
 *
 * Fixtures are generated deterministically by signing with @naulon/shared's signBotAuth, with a
 * fixed Ed25519 seed and a fixed created timestamp, so the signature bytes below are stable and
 * re-derivable rather than hand-typed. See the reference "fleet-pull" tests in
 * packages/enforce/src/decide.fleet-pull.test.ts for the same shapes proven against the
 * TypeScript verifier, including the tenant-binding cases.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class FleetPullTest extends TestCase {

	const HOST             = 'site.example';
	const PATH             = '/essays/x';
	const FLEET_AGENT      = 'fleet.example';
	const FLEET_PUBLISHER  = 'pub_test';
	const CREATED          = 1700000000;

	/** keyid (RFC 7638 thumbprint) => base64url x, for the fleet's own signing key. */
	const FLEET_DIRECTORY = array(
		'--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck' => '6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw',
	);

	/** Signed over ("@authority" "@path" "x-naulon-publisher") for site.example/essays/x, header
	 *  x-naulon-publisher=pub_test, agent "fleet.example", created=1700000000, expires=1700000060. */
	const VALID = array(
		'signature-input'    => 'sig1=("@authority" "@path" "x-naulon-publisher");created=1700000000;expires=1700000060;keyid="--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck";tag="web-bot-auth"',
		'signature'          => 'sig1=:HtwU8ihTnvPn+EMkkdWj1wCqyDDnPL2w19QpOnglyKbPau2dL4r5mGmz2Yama/5JV6muBheAlC0s09Uc+6H+Dg==:',
		'signature-agent'    => '"fleet.example"',
		'x-naulon-publisher' => 'pub_test',
	);

	/** Same signer, same host/path, but the covered set stops at ("@authority" "@path") — the
	 *  request still carries a matching x-naulon-publisher header, it is just not signed. */
	const PUBLISHER_NOT_COVERED = array(
		'signature-input'    => 'sig1=("@authority" "@path");created=1700000000;expires=1700000060;keyid="--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck";tag="web-bot-auth"',
		'signature'          => 'sig1=:IQCOPSEaWf6k6z3p1ov717qKgJpYzlmDZYHTamFrcMZ+YhKKFPc9en9UtVtA9QeIcIo5lgPS3z9/5XNlVPVkCg==:',
		'signature-agent'    => '"fleet.example"',
		'x-naulon-publisher' => 'pub_test',
	);

	/** Covers ("@authority" "x-naulon-publisher") — no @path. */
	const NO_PATH = array(
		'signature-input'    => 'sig1=("@authority" "x-naulon-publisher");created=1700000000;expires=1700000060;keyid="--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck";tag="web-bot-auth"',
		'signature'          => 'sig1=:NSG4A354EOTeyGj0TVoh+8Fu6nULTqgXUQ9WRjKwYn5ThTmP51f3Gq5JQ5Neis0EcJ/qEIfx8f5KeIiyTBtABQ==:',
		'signature-agent'    => '"fleet.example"',
		'x-naulon-publisher' => 'pub_test',
	);

	/** Signed by a DIFFERENT operator's own key, over the full three components including
	 *  x-naulon-publisher=pub_test, naming its own host "other.example" as the Signature-Agent —
	 *  a cryptographically valid signature for an operator this site never configured as its
	 *  fleet agent. */
	const OTHER_AGENT = array(
		'signature-input'    => 'sig1=("@authority" "@path" "x-naulon-publisher");created=1700000000;expires=1700000060;keyid="E916XTjJCK82vAibEGGhB3lDV7wANvlLfxiCNTqfo_c";tag="web-bot-auth"',
		'signature'          => 'sig1=:VbS3WevluGS9rhTGHSt99K24WkUuPZ3bUhzek6c690IJNUc0WHtSwCUKai0h885ejzQ+4PPcOa/izu0YrGn9Bw==:',
		'signature-agent'    => '"other.example"',
		'x-naulon-publisher' => 'pub_test',
	);

	/** Signed by the fleet's own key, full three components, but for a DIFFERENT tenant
	 *  ("someone-else") whose origin also happens to be this site. */
	const OTHER_TENANT = array(
		'signature-input'    => 'sig1=("@authority" "@path" "x-naulon-publisher");created=1700000000;expires=1700000060;keyid="--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck";tag="web-bot-auth"',
		'signature'          => 'sig1=:gi6v0ksPd4HDbSIMNJFn9fSiwXljwvwHU3QALxVDRAKnZuw32BI8Gyl1HJGapMmbPOmq9xZp7rAP6Qeq+cmQAQ==:',
		'signature-agent'    => '"fleet.example"',
		'x-naulon-publisher' => 'someone-else',
	);

	/** Byte-identical to VALID except one bit flipped inside the signature, re-encoded to the
	 *  same base64 length — a tamper the parser accepts and the crypto check must reject. */
	const TAMPERED = array(
		'signature-input'    => 'sig1=("@authority" "@path" "x-naulon-publisher");created=1700000000;expires=1700000060;keyid="--6IM5l0OosLj9yWskISYhUA3n_3CURQkmrYMSha_ck";tag="web-bot-auth"',
		'signature'          => 'sig1=:HtwU8ihTnvPn+EIkkdWj1wCqyDDnPL2w19QpOnglyKbPau2dL4r5mGmz2Yama/5JV6muBheAlC0s09Uc+6H+Dg==:',
		'signature-agent'    => '"fleet.example"',
		'x-naulon-publisher' => 'pub_test',
	);

	public function test_the_fleet_pull_signed_over_this_path_and_tenant_verifies() {
		$this->assertTrue(
			Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 )
		);
	}

	public function test_a_signature_for_another_page_does_not_verify_here() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, '/essays/other', self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'the @path line is built from the path actually being served, so a signature made for one path must not verify for another'
		);
	}

	public function test_a_signature_that_does_not_cover_path_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::NO_PATH, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'covering only @authority (plus the tenant header) is not bound to this resource, so it must never waive the toll on a specific page'
		);
	}

	public function test_another_operators_valid_signature_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::OTHER_AGENT, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'cryptographically valid for its own operator is not the same as valid for THIS site\'s configured fleet agent'
		);
	}

	public function test_an_expired_signature_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 200 ),
			'expires=1700000060 plus the clock-skew allowance is well behind CREATED+200'
		);
	}

	public function test_a_tampered_signature_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::TAMPERED, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'a single flipped bit must fail the sodium check even though every header still parses'
		);
	}

	public function test_an_unconfigured_fleet_agent_disables_the_rule() {
		$this->assertFalse( Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, self::PATH, '', self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ) );
	}

	public function test_an_unconfigured_fleet_publisher_disables_the_rule() {
		$this->assertFalse( Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, self::PATH, self::FLEET_AGENT, '', self::FLEET_DIRECTORY, self::CREATED + 10 ) );
	}

	public function test_an_unknown_keyid_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::VALID, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, array(), self::CREATED + 10 ),
			'a directory that does not carry this keyid must refuse rather than skip the check'
		);
	}

	/**
	 * The gate signs a pull for EVERY tenant it hosts, so a cryptographically valid signature from
	 * the fleet's own key, over the right host and path, still proves nothing about WHICH tenant
	 * it was decided for. Another tenant can name this site as its own origin.
	 */
	public function test_a_pull_signed_for_another_tenant_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::OTHER_TENANT, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'signed for "someone-else" must not open this site\'s content, configured for "pub_test"'
		);
	}

	/**
	 * A matching x-naulon-publisher header that the signature does not cover is not trusted: it
	 * could be added by anything between the gate and this origin, and the signature says nothing
	 * about it.
	 */
	public function test_a_matching_publisher_header_the_signature_does_not_cover_is_refused() {
		$this->assertFalse(
			Naulon_Fleet_Pull::verify_with_directory( self::PUBLISHER_NOT_COVERED, self::HOST, self::PATH, self::FLEET_AGENT, self::FLEET_PUBLISHER, self::FLEET_DIRECTORY, self::CREATED + 10 ),
			'the header value must be part of what was signed, not just present alongside it'
		);
	}
}
