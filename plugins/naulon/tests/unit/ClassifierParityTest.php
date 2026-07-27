<?php
/**
 * The drift guard for the one piece of logic this plugin genuinely duplicates.
 *
 * Classification has to run locally (see the class docblock for why), so the agent UA list
 * exists twice: once in TypeScript, once in PHP. A second copy of a list that changes whenever
 * a new crawler appears is exactly the kind of thing that silently rots — six months later the
 * gate charges GPTBot-9 and WordPress serves it free, and nobody notices because nothing fails.
 *
 * So this test does not restate the list. It READS the TypeScript source that defines it and
 * asserts the PHP array matches, element for element, in order. The plugin lives in the same
 * monorepo as the kernel precisely so this is possible: the two files are always in the same
 * checkout at the same commit.
 *
 * If this fails, the fix is never to edit the assertion — it is to copy the upstream list.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class ClassifierParityTest extends TestCase {

	/** The kernel file that owns the list. Relative to this plugin inside the monorepo. */
	const KERNEL_SOURCE = '/../../../../packages/enforce/src/agentDetect.ts';

	private function kernel_path() {
		return __DIR__ . self::KERNEL_SOURCE;
	}

	public function test_the_typescript_source_is_where_we_think_it_is() {
		// If the monorepo layout moves, this test must fail loudly rather than silently stop
		// checking anything — a parity test that quietly skips is worse than no parity test.
		$this->assertFileExists(
			$this->kernel_path(),
			'the classifier parity guard cannot find the kernel source; fix the path, do not delete the test'
		);
	}

	public function test_the_php_agent_ua_list_matches_the_typescript_one_exactly() {
		$source = file_get_contents( $this->kernel_path() );
		$this->assertIsString( $source );

		$matched = preg_match( '/const KNOWN_AGENT_UA = \[(.*?)\];/s', $source, $m );
		$this->assertSame( 1, $matched, 'could not locate KNOWN_AGENT_UA in the kernel source' );

		preg_match_all( '/"([^"]+)"/', $m[1], $entries );
		$upstream = $entries[1];

		$this->assertNotEmpty( $upstream, 'parsed an empty upstream list — the parser is wrong, not the lists' );
		$this->assertSame(
			$upstream,
			Naulon_Agent::KNOWN_AGENT_UA,
			"the PHP agent UA list has drifted from packages/enforce/src/agentDetect.ts.\n" .
			'Copy the upstream list into Naulon_Agent::KNOWN_AGENT_UA — do not edit this test.'
		);
	}

	public function test_search_indexers_are_absent_from_both_lists() {
		// Tolling a search crawler silently deindexes the publisher. This is a property of the
		// list, not of either copy, so assert it directly rather than trusting review.
		foreach ( array( 'googlebot', 'bingbot', 'oai-searchbot', 'claude-searchbot', 'duckduckbot' ) as $indexer ) {
			$this->assertNotContains(
				$indexer,
				Naulon_Agent::KNOWN_AGENT_UA,
				sprintf( 'charging %s by default would deindex the publisher', $indexer )
			);
		}
	}
}
