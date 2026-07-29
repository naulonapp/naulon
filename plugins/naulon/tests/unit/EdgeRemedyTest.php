<?php
/**
 * The remedy the Test toll screen appends when a crawler was served a priced article free.
 *
 * These strings are publisher-facing copy on a branch the admin screens cannot reach without a
 * live control plane and a priced article, so nothing else verifies that they say the right thing
 * to the right person. The discrimination is the point: `cf-cache-status` is on EVERY Cloudflare
 * response including `DYNAMIC`, which means Cloudflare did not serve it from cache. Telling that
 * publisher to go rewrite their cache rules is the same class of wrong answer as the copy this
 * screen shipped with before 2026-07-29 ("either enforcement is off, or something is answering
 * before WordPress runs"), which sent a session at caching for an hour while the real cause was
 * the control plane pricing the article as free.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class EdgeRemedyTest extends TestCase {

	/** Cloudflare actually answered ⇒ the fix is at Cloudflare, and it names both settings. */
	public function test_a_cloudflare_hit_gets_the_cloudflare_remedy() {
		foreach ( array( 'HIT', 'STALE', 'UPDATING', 'REVALIDATED' ) as $status ) {
			$out = Naulon_Cache::edge_remedy( array( 'cf-cache-status' => $status ) );
			$this->assertStringContainsString( 'Cloudflare served this from its own cache', $out, $status );
			$this->assertStringContainsString( 'Cache Everything', $out, $status );
			$this->assertStringContainsString( 'APO', $out, $status );
			$this->assertStringContainsString( 'Purge', $out, $status );
		}
	}

	/** Present but not the cause — must NOT send them to Cloudflare's settings. */
	public function test_a_non_serving_cloudflare_status_points_back_inside_wordpress() {
		foreach ( array( 'DYNAMIC', 'MISS', 'BYPASS', 'EXPIRED' ) as $status ) {
			$out = Naulon_Cache::edge_remedy( array( 'cf-cache-status' => $status ) );
			$this->assertStringContainsString( 'did not answer this request from cache', $out, $status );
			$this->assertStringContainsString( 'inside WordPress', $out, $status );
			$this->assertStringNotContainsString( 'Cache Everything', $out, $status );
		}
	}

	/** A non-Cloudflare CDN that reports a hit gets the generic-CDN remedy. */
	public function test_a_generic_cdn_hit_gets_the_generic_remedy() {
		$out = Naulon_Cache::edge_remedy( array( 'x-cache' => 'HIT from cloudfront' ) );
		$this->assertStringContainsString( 'A CDN in front of this site answered from its cache', $out );
		$this->assertStringNotContainsString( 'Cloudflare served this', $out );
	}

	/** No edge in the evidence ⇒ say nothing rather than guess at a layer. */
	public function test_no_edge_headers_yields_no_remedy() {
		$this->assertSame( '', Naulon_Cache::edge_remedy( array() ) );
		$this->assertSame( '', Naulon_Cache::edge_remedy( array( 'age' => '0' ) ) );
		$this->assertSame( '', Naulon_Cache::edge_remedy( array( 'x-cache' => 'MISS' ) ) );
	}

	/** It is appended to an existing sentence, so it must carry its own leading space and not double one. */
	public function test_the_remedy_joins_the_sentence_cleanly() {
		$out = Naulon_Cache::edge_remedy( array( 'cf-cache-status' => 'HIT' ) );
		$this->assertSame( ' ', substr( $out, 0, 1 ) );
		$this->assertNotSame( '  ', substr( $out, 0, 2 ) );
		$sentence = 'The response headers below name the layer.' . $out;
		$this->assertStringNotContainsString( '.  ', $sentence );
	}

	/** Header casing is not ours to control — it comes off the wire. */
	public function test_header_names_and_values_are_matched_case_insensitively() {
		$this->assertStringContainsString(
			'Cloudflare served this from its own cache',
			Naulon_Cache::edge_remedy( array( 'CF-Cache-Status' => 'hit' ) )
		);
	}
}
