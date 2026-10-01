<?php
/**
 * The user agents Diagnostics tells a publisher to keep out of their page cache. A page cache
 * answers before any plugin runs, so a crawler it serves is never checked: once a site is armed
 * for an operator, that operator's fragments must be on the list too, or a forged claim reads the
 * cached copy for free.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class CacheExclusionTest extends TestCase {

	public function test_unarmed_site_lists_only_the_charged_agents() {
		$this->assertSame( Naulon_Agent::KNOWN_AGENT_UA, Naulon_Cache::exclusion_fragments() );
		$this->assertNotContains( 'googlebot', Naulon_Cache::exclusion_fragments() );
	}

	public function test_an_armed_operator_joins_the_list() {
		$list = Naulon_Cache::exclusion_fragments( array( 'google', 'anthropic' ) );
		$this->assertContains( 'googlebot', $list );
		$this->assertContains( 'claude-searchbot', $list );
		$this->assertSame( count( $list ), count( array_unique( $list ) ) );
		foreach ( Naulon_Agent::KNOWN_AGENT_UA as $f ) {
			$this->assertContains( $f, $list );
		}
	}

	public function test_an_unknown_operator_id_adds_nothing() {
		$this->assertSame( Naulon_Agent::KNOWN_AGENT_UA, Naulon_Cache::exclusion_fragments( array( 'nobody' ) ) );
	}
}
