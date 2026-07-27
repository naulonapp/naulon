<?php
/**
 * Classification. Every test here is "would a human have been charged", which is the failure
 * mode that matters — the reverse (a bot reading free) costs a micro-toll and nothing else.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class AgentTest extends TestCase {

	const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

	private function signals( array $over = array() ) {
		return array_merge(
			array(
				'user_agent'         => self::CHROME,
				'accept'             => 'text/html,application/xhtml+xml',
				'has_payment_header' => false,
				'declared_agent_id'  => '',
				'headers'            => array(),
			),
			$over
		);
	}

	public function test_a_normal_browser_is_a_human() {
		$v = Naulon_Agent::classify( $this->signals() );
		$this->assertSame( 'human', $v['kind'] );
	}

	public function test_a_browser_without_an_html_accept_is_still_human_via_sec_fetch() {
		$v = Naulon_Agent::classify(
			$this->signals(
				array(
					'accept'  => '*/*',
					'headers' => array( 'sec-fetch-mode' => true ),
				)
			)
		);
		$this->assertSame( 'human', $v['kind'] );
		$this->assertSame( 'browser-shaped request', $v['reason'] );
	}

	public function test_an_ambiguous_request_defaults_to_human() {
		$v = Naulon_Agent::classify(
			$this->signals(
				array(
					'user_agent' => 'SomeUnknownThing/1.0',
					'accept'     => '*/*',
				)
			)
		);
		$this->assertSame( 'human', $v['kind'] );
		$this->assertStringContainsString( 'ambiguous', $v['reason'] );
	}

	public function test_a_payment_header_is_the_strongest_agent_signal() {
		// Even with a browser UA: presenting x402 IS a declaration of what you are.
		$v = Naulon_Agent::classify( $this->signals( array( 'has_payment_header' => true ) ) );
		$this->assertSame( 'agent', $v['kind'] );
		$this->assertSame( 0.99, $v['confidence'] );
	}

	public function test_a_declared_agent_id_is_an_agent() {
		$v = Naulon_Agent::classify( $this->signals( array( 'declared_agent_id' => 'research-bot' ) ) );
		$this->assertSame( 'agent', $v['kind'] );
		$this->assertStringContainsString( 'research-bot', $v['reason'] );
	}

	public function test_known_crawlers_are_agents() {
		foreach ( array( 'GPTBot/1.0', 'ClaudeBot/1.0', 'CCBot/2.0', 'python-requests/2.31', 'curl/8.4.0' ) as $ua ) {
			$v = Naulon_Agent::classify( $this->signals( array( 'user_agent' => $ua, 'accept' => '*/*' ) ) );
			$this->assertSame( 'agent', $v['kind'], $ua . ' should be an agent' );
		}
	}

	public function test_user_triggered_assistant_fetches_are_the_citation_moment_and_are_charged() {
		foreach ( array( 'ChatGPT-User/1.0', 'Claude-User/1.0', 'Perplexity-User/1.0' ) as $ua ) {
			$v = Naulon_Agent::classify( $this->signals( array( 'user_agent' => $ua ) ) );
			$this->assertSame( 'agent', $v['kind'], $ua . ' is machine-only, so charging it cannot toll a human' );
		}
	}

	public function test_search_indexers_read_free_by_default() {
		// Charging these silently deindexes the publisher — the opposite of what they want.
		foreach ( array( 'Googlebot/2.1', 'bingbot/2.0', 'OAI-SearchBot/1.0', 'Claude-SearchBot/1.0' ) as $ua ) {
			$v = Naulon_Agent::classify( $this->signals( array( 'user_agent' => $ua, 'accept' => '*/*' ) ) );
			$this->assertSame( 'human', $v['kind'], $ua . ' must read free' );
		}
	}

	public function test_the_publisher_allowlist_frees_a_crawler_that_the_builtin_list_would_charge() {
		$v = Naulon_Agent::classify(
			$this->signals( array( 'user_agent' => 'CCBot/2.0', 'accept' => '*/*' ) ),
			array( 'seo_allowlist' => array( 'ccbot' ) )
		);
		$this->assertSame( 'human', $v['kind'] );
	}

	public function test_the_publisher_charge_list_tolls_something_the_default_reads_as_human() {
		$v = Naulon_Agent::classify(
			$this->signals( array( 'user_agent' => 'SomeScraper/1.0', 'accept' => '*/*' ) ),
			array( 'charge_list' => array( 'somescraper' ) )
		);
		$this->assertSame( 'agent', $v['kind'] );
	}

	public function test_allow_beats_charge_when_both_match() {
		$v = Naulon_Agent::classify(
			$this->signals( array( 'user_agent' => 'CCBot/2.0', 'accept' => '*/*' ) ),
			array(
				'seo_allowlist' => array( 'ccbot' ),
				'charge_list'   => array( 'ccbot' ),
			)
		);
		$this->assertSame( 'human', $v['kind'], 'allow must win an overlap — the safe direction' );
	}

	public function test_matching_is_case_insensitive_in_both_directions() {
		$v = Naulon_Agent::classify( $this->signals( array( 'user_agent' => 'GPTBOT/1.0', 'accept' => '*/*' ) ) );
		$this->assertSame( 'agent', $v['kind'] );

		$v = Naulon_Agent::classify(
			$this->signals( array( 'user_agent' => 'ccbot/2.0', 'accept' => '*/*' ) ),
			array( 'seo_allowlist' => array( 'CCBot' ) )
		);
		$this->assertSame( 'human', $v['kind'] );
	}

	public function test_an_empty_user_agent_is_not_charged() {
		$v = Naulon_Agent::classify( $this->signals( array( 'user_agent' => '', 'accept' => '*/*' ) ) );
		$this->assertSame( 'human', $v['kind'] );
	}
}
