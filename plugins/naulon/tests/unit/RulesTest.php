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
}
