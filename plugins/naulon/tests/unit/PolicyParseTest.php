<?php
/**
 * Parsing the two user-agent lists a publisher types on the Content screen.
 *
 * The lower-casing is the load-bearing part and the easiest thing to get wrong: the classifier
 * compares fragments against an already-lower-cased user agent, so a fragment typed as "GPTBot"
 * would never match anything and the publisher would conclude the feature does not work.
 *
 * @package naulon
 */

class PolicyParseTest extends PHPUnit\Framework\TestCase {

	public function test_lines_become_fragments() {
		$this->assertSame(
			array( 'yandex', 'partner-crawler' ),
			Naulon_Admin_Content::parse_fragments( "yandex\npartner-crawler" )
		);
	}

	public function test_fragments_are_lower_cased_so_they_can_actually_match() {
		$this->assertSame( array( 'gptbot' ), Naulon_Admin_Content::parse_fragments( 'GPTBot' ) );
	}

	public function test_blank_lines_and_whitespace_are_dropped() {
		$this->assertSame(
			array( 'a-crawler', 'b-crawler' ),
			Naulon_Admin_Content::parse_fragments( "  a-crawler  \n\n\n   \n b-crawler\n" )
		);
	}

	public function test_duplicates_collapse() {
		$this->assertSame(
			array( 'ccbot' ),
			Naulon_Admin_Content::parse_fragments( "ccbot\nCCBot\n ccbot " )
		);
	}

	public function test_carriage_returns_from_a_windows_browser_do_not_survive() {
		$this->assertSame(
			array( 'one', 'two' ),
			Naulon_Admin_Content::parse_fragments( "one\r\ntwo" )
		);
	}

	public function test_empty_input_is_an_empty_list_not_a_list_containing_nothing() {
		// A list holding one empty fragment would match EVERY user agent — every reader would be
		// charged or freed depending on which box it was typed into. It must be empty.
		$this->assertSame( array(), Naulon_Admin_Content::parse_fragments( '' ) );
		$this->assertSame( array(), Naulon_Admin_Content::parse_fragments( "\n\n  \n" ) );
	}

	public function test_a_parsed_allow_fragment_frees_a_bot_the_builtin_list_would_charge() {
		$policy = array( 'seo_allowlist' => Naulon_Admin_Content::parse_fragments( 'GPTBot' ) );
		$verdict = Naulon_Agent::classify( array( 'user_agent' => 'GPTBot/1.2' ), $policy );
		$this->assertSame( 'human', $verdict['kind'] );
	}

	public function test_a_parsed_charge_fragment_charges_a_ua_the_builtin_list_would_free() {
		$policy = array( 'charge_list' => Naulon_Admin_Content::parse_fragments( 'Some-New-Crawler' ) );
		$verdict = Naulon_Agent::classify( array( 'user_agent' => 'Some-New-Crawler/9' ), $policy );
		$this->assertSame( 'agent', $verdict['kind'] );
	}
}
