<?php
/**
 * The dashboard's rules, applied by the plugin. The order is the gate's: a block before anything,
 * a refusal by the terms before the free read, and free agent reads after the human check.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class RulesTest extends TestCase {

	private function signals( $ua, array $over = array() ) {
		return array_merge(
			array(
				'user_agent'         => $ua,
				'accept'             => '*/*',
				'has_payment_header' => false,
				'declared_agent_id'  => '',
				'headers'            => array(),
			),
			$over
		);
	}

	private function rules( array $over = array() ) {
		return Naulon_Rules::normalize(
			array_merge(
				array(
					'block'          => array(),
					'allow'          => array(),
					'charge'         => array(),
					'refuse'         => array(
						'crawlers' => array(),
						'agents'   => false,
					),
					'agentReadsFree' => false,
				),
				$over
			)
		);
	}

	public function test_no_rules_behaves_exactly_as_before() {
		$a = Naulon_Rules::access( $this->signals( 'GPTBot/1.0' ), null, array() );
		$this->assertSame( 'continue', $a['action'] );
	}

	public function test_a_blocked_crawler_is_refused_even_when_it_offers_to_pay() {
		$a = Naulon_Rules::access(
			$this->signals( 'Mozilla/5.0 (compatible; GPTBot/1.2)', array( 'has_payment_header' => true ) ),
			$this->rules( array( 'block' => array( 'gptbot' ) ) ),
			array()
		);
		$this->assertSame( 'blocked', $a['action'] );
	}

	public function test_a_refused_term_beats_an_allow_exception() {
		$rules = $this->rules(
			array(
				'allow'  => array( 'chatgpt-user' ),
				'refuse' => array(
					'crawlers' => array( array( 'chatgpt-user', true ) ),
					'agents'   => true,
				),
			)
		);
		$this->assertSame( 'blocked', Naulon_Rules::access( $this->signals( 'ChatGPT-User/1.0' ), $rules, array() )['action'] );
	}

	public function test_the_first_registry_hit_decides() {
		// `applebot-extended` (training) is listed before `applebot` (search). Refusing search must
		// not refuse the training crawler whose user agent happens to contain `applebot`.
		$rules = $this->rules(
			array(
				'refuse' => array(
					'crawlers' => array( array( 'applebot-extended', false ), array( 'applebot', true ) ),
					'agents'   => false,
				),
			)
		);
		$this->assertNull( Naulon_Rules::refusal( 'Applebot-Extended/1.0', 'agent', $rules ) );
		$this->assertNotNull( Naulon_Rules::refusal( 'Applebot/1.0', 'human', $rules ) );
	}

	public function test_a_person_is_never_refused() {
		$rules = $this->rules( array( 'refuse' => array( 'crawlers' => array(), 'agents' => true ) ) );
		$a     = Naulon_Rules::access(
			$this->signals( 'Mozilla/5.0 (Macintosh) Chrome/120', array( 'accept' => 'text/html' ) ),
			$rules,
			array()
		);
		$this->assertSame( 'free', $a['action'] );
	}

	public function test_free_terms_serve_an_agent_free_but_keep_a_block() {
		$rules = $this->rules( array( 'agentReadsFree' => true, 'block' => array( 'ccbot' ) ) );
		$this->assertSame( 'free', Naulon_Rules::access( $this->signals( 'GPTBot/1.0' ), $rules, array() )['action'] );
		$this->assertSame( 'blocked', Naulon_Rules::access( $this->signals( 'CCBot/2.0' ), $rules, array() )['action'] );
	}

	public function test_malformed_rules_normalize_to_nothing() {
		$r = Naulon_Rules::normalize( array( 'block' => 'gptbot', 'refuse' => array( 'crawlers' => array( 'x', array( 1, 2 ) ) ) ) );
		$this->assertSame( array(), $r['block'] );
		$this->assertSame( array(), $r['refuse']['crawlers'] );
		$this->assertFalse( $r['agentReadsFree'] );
	}

	/* Identity: a forged crawler claim, decided in the gate's order. */

	const T0 = 1790812800;

	private function identity_ctx( $ip, array $armed = array( 'google' ) ) {
		$doc = Naulon_Ranges::validate(
			array(
				'version'     => 1,
				'generatedAt' => gmdate( 'c', self::T0 ),
				'proxies'     => array(),
				'operators'   => array(
					array(
						'id'             => 'google',
						'operator'       => 'Google',
						'fragments'      => array( 'googlebot' ),
						'kind'           => 'ranges',
						'forgedEligible' => true,
						'fetchedAt'      => gmdate( 'c', self::T0 - 3600 ),
						'prefixes'       => array( '66.249.64.0/27' ),
					),
				),
			)
		);
		return array(
			'compiled'  => Naulon_Ranges::compile( $doc ),
			'client_ip' => $ip,
			'now'       => self::T0,
			'armed'     => $armed,
		);
	}

	private function googlebot() {
		return $this->signals( 'Mozilla/5.0 (compatible; Googlebot/2.1)', array( 'accept' => 'text/html' ) );
	}

	public function test_normalize_keeps_known_forged_and_identity_mode_values_only() {
		$r = $this->rules( array( 'forged' => 'block', 'identityMode' => 'off' ) );
		$this->assertSame( 'block', $r['forged'] );
		$this->assertSame( 'off', $r['identityMode'] );
		$r = $this->rules( array( 'forged' => 'maybe', 'identityMode' => 'sometimes' ) );
		$this->assertSame( 'charge', $r['forged'] );
		$this->assertSame( 'auto', $r['identityMode'] );
	}

	public function test_an_armed_forged_googlebot_loses_its_free_read() {
		$out = Naulon_Rules::access( $this->googlebot(), $this->rules(), array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '9.9.9.9' ) );
		$this->assertSame( 'continue', $out['action'] );
		$this->assertSame( 'forged', $out['identity']['check'] );
		$this->assertSame( 'google', $out['forged_claim']['operator_id'] );
	}

	public function test_forged_block_refuses_it() {
		$out = Naulon_Rules::access( $this->googlebot(), $this->rules( array( 'forged' => 'block' ) ), array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '9.9.9.9' ) );
		$this->assertSame( 'blocked', $out['action'] );
		// The audit row and the 403 name the forgery, as the gate's classifyReason does. "Blocked
		// by publisher" would be false: this publisher allowlisted Googlebot.
		$this->assertSame( 'claimed "googlebot" from an address outside Google\'s published ranges', $out['reason'] );
	}

	public function test_identity_mode_off_reads_free_and_checks_nothing() {
		$out = Naulon_Rules::access( $this->googlebot(), $this->rules( array( 'identityMode' => 'off' ) ), array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '9.9.9.9' ) );
		$this->assertSame( 'free', $out['action'] );
		$this->assertNull( $out['identity'] );
	}

	public function test_unarmed_forged_claim_reads_free_and_is_still_reported() {
		$out = Naulon_Rules::access( $this->googlebot(), $this->rules(), array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '9.9.9.9', array() ) );
		$this->assertSame( 'free', $out['action'] );
		$this->assertSame( 'forged', $out['identity']['check'] );
	}

	public function test_real_googlebot_reads_free() {
		$out = Naulon_Rules::access( $this->googlebot(), $this->rules(), array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '66.249.64.9' ) );
		$this->assertSame( 'free', $out['action'] );
		$this->assertSame( 'ip-verified', $out['identity']['check'] );
	}

	/** Null rules (control plane unreachable) still check, still report, and arm from the last list. */
	public function test_no_rules_still_checks_the_claim() {
		$out = Naulon_Rules::access( $this->googlebot(), null, array( 'seo_allowlist' => array( 'googlebot' ) ), $this->identity_ctx( '9.9.9.9' ) );
		$this->assertSame( 'continue', $out['action'] );
	}

	/**
	 * An armed set nobody has refreshed is missing evidence, and missing evidence never charges.
	 * After ARMED_MAX_AGE it reads as empty, so a disarm the site never heard about still lands.
	 */
	public function test_an_aged_armed_set_reads_empty() {
		$stored = array( 'ids' => array( 'google' ), 'stored_at' => self::T0 );
		$this->assertSame( array( 'google' ), Naulon_Rules::armed_from( $stored, self::T0 + Naulon_Rules::ARMED_MAX_AGE ) );
		$this->assertSame( array(), Naulon_Rules::armed_from( $stored, self::T0 + Naulon_Rules::ARMED_MAX_AGE + 1 ) );
		$this->assertSame( array(), Naulon_Rules::armed_from( array( 'google' ), self::T0 ) );
		$this->assertSame( array(), Naulon_Rules::armed_from( null, self::T0 ) );
		$this->assertLessThan( 72 * 3600, Naulon_Rules::ARMED_MAX_AGE );
	}

	public function test_normalize_keeps_the_toll_mode_only_as_observe_or_charge() {
		$this->assertSame( 'observe', $this->rules( array( 'tollMode' => 'observe' ) )['tollMode'] );
		$this->assertSame( 'charge', $this->rules( array( 'tollMode' => 'charge' ) )['tollMode'] );
		// Anything else charges: a malformed mode must never switch the toll off.
		$this->assertSame( 'charge', $this->rules( array( 'tollMode' => 'OBSERVE' ) )['tollMode'] );
		$this->assertSame( 'charge', $this->rules( array() )['tollMode'] );
	}
}
