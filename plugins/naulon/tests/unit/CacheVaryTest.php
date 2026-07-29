<?php
/**
 * `Vary: User-Agent` on a tolled route.
 *
 * The failure this guards is the quiet one. A tolled article URL answers a human 200 and an
 * agent 402 from the same path, so a shared cache keying on URL alone may store the human's
 * response and later hand it to a crawler: a free read with no 402, no quote call, no earnings,
 * and no trace anywhere in WordPress, because PHP never ran. The drop-in cannot help — what is
 * being replayed is a legitimate human response the publisher is entitled to cache.
 *
 * The naulon gate stamps the same header on every gateable-route response for the same reason
 * (`stampGateCacheHeaders`, packages/tollgate/src/app.ts). These cases pin the merge so the
 * publisher's own Vary is never clobbered and the header is never doubled.
 *
 * @package naulon
 */

use PHPUnit\Framework\TestCase;

class CacheVaryTest extends TestCase {

	public function test_unset_vary_becomes_user_agent() {
		$this->assertSame( 'User-Agent', Naulon_Enforcer::merge_vary( '' ) );
		$this->assertSame( 'User-Agent', Naulon_Enforcer::merge_vary( '   ' ) );
	}

	public function test_existing_vary_is_appended_to_not_replaced() {
		$this->assertSame( 'Accept-Encoding, User-Agent', Naulon_Enforcer::merge_vary( 'Accept-Encoding' ) );
		$this->assertSame(
			'Accept-Encoding, Cookie, User-Agent',
			Naulon_Enforcer::merge_vary( 'Accept-Encoding, Cookie' )
		);
	}

	/** Already covered ⇒ send nothing, so the origin's own header survives untouched. */
	public function test_user_agent_already_present_sends_nothing() {
		$this->assertSame( '', Naulon_Enforcer::merge_vary( 'User-Agent' ) );
		$this->assertSame( '', Naulon_Enforcer::merge_vary( 'Accept-Encoding, User-Agent' ) );
	}

	/** HTTP field names are case-insensitive; a theme writing `user-agent` must not be doubled. */
	public function test_matching_is_case_insensitive_and_whitespace_tolerant() {
		$this->assertSame( '', Naulon_Enforcer::merge_vary( 'user-agent' ) );
		$this->assertSame( '', Naulon_Enforcer::merge_vary( 'USER-AGENT' ) );
		$this->assertSame( '', Naulon_Enforcer::merge_vary( '  Accept-Encoding ,  User-Agent  ' ) );
	}

	/** `Vary: *` means "vary on everything" — already stricter than what we would add. */
	public function test_wildcard_vary_is_left_alone() {
		$this->assertSame( '', Naulon_Enforcer::merge_vary( '*' ) );
	}
}
